const { TextDecoder } = require("util");
require("es-get-iterator");
global.TextDecoder = class extends TextDecoder {
  constructor(enc) {
    if (enc === "ascii") enc = "latin1";
    super(enc);
  }
};

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const { spawn } = require('child_process');
const { initializeApp } = require('firebase/app');
const {
    getFirestore, collection, query, where, onSnapshot,
    updateDoc, deleteDoc, doc, runTransaction, getDocs
} = require('firebase/firestore');

const ThermalPrinter = require("node-thermal-printer").printer;
const PrinterTypes = require("node-thermal-printer").types;

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const basePath = process.pkg ? path.dirname(process.execPath) : __dirname;
const configPath = path.join(basePath, 'config.json');
const SUMATRA_PATH = path.join(basePath, 'SumatraPDF-3.4.6-32.exe');
const FONT_PATH = path.join(basePath, 'Roboto-Regular.ttf');
const FONT_BOLD_PATH = path.join(basePath, 'Roboto-Bold.ttf');

const CONFIG = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// ─────────────────────────────────────────────
// HOT RELOAD CONFIG
// ─────────────────────────────────────────────
setInterval(() => {
    try {
        const newConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const oldPrinters = JSON.stringify(CONFIG.printers);
        const newPrinters = JSON.stringify(newConfig.printers);
        if (oldPrinters !== newPrinters) {
            Object.keys(CONFIG).forEach(key => delete CONFIG[key]);
            Object.assign(CONFIG, newConfig);
            writeLog('SYSTEM', `Config đã được reload — máy in mới: ${newPrinters}`);
            console.log(`\x1b[33m[CONFIG]\x1b[0m Phát hiện thay đổi config, đã reload máy in mới`);
        }
    } catch(e) {}
}, 30000);

const PORT = CONFIG.port || 8686;
const PAPER_WIDTH = CONFIG.paperWidthMM === 80 ? 226 : 165;
let globalBranchConfig = {};

// ─────────────────────────────────────────────
// CẤU TRÚC HÀNG ĐỢI DÙNG CHUNG
// ─────────────────────────────────────────────
let isPrinting = false;
const localPrintQueue = [];
const enqueuedIds = new Set();
const printedIds = new Set(); 

// ─────────────────────────────────────────────
// HỆ THỐNG GHI LOG (CHỐNG TRÀN RAM)
// ─────────────────────────────────────────────
const LOG_PATH = path.join(basePath, 'print.log');
let currentLogDate = new Date().toDateString();

function writeLog(level, message) {
    const today = new Date().toDateString();
    
    if (today !== currentLogDate) {
        try { fs.writeFileSync(LOG_PATH, '', 'utf8'); } catch(e) {}
        currentLogDate = today;
        enqueuedIds.clear(); 
        printedIds.clear();  
    }
    
    const time = new Date().toLocaleTimeString('vi-VN');
    const logStr = `[${time}] [${level}] ${message}\n`;
    
    fs.appendFile(LOG_PATH, logStr, 'utf8', (err) => {
        if (err) console.error("Lỗi ghi log:", err);
    });
}

const _log = console.log.bind(console);
const _err = console.error.bind(console);
console.log = (...args) => {
    _log(...args);
    writeLog('INFO', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
};
console.error = (...args) => {
    _err(...args);
    writeLog('ERROR', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
};

// ─────────────────────────────────────────────
// LUỒNG 1: IN QUA WINDOWS (SumatraPDF)
// ─────────────────────────────────────────────
function printPdf(pdfPath, printerName) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(pdfPath)) return reject(new Error("File PDF chưa được tạo thành công."));
        
        const args = ['-print-to', printerName, '-silent', pdfPath];
        const child = spawn(SUMATRA_PATH, args, { windowsHide: true });

        const timeout = setTimeout(() => {
            child.kill();
            reject(new Error('SumatraPDF timeout - máy in có thể bị treo'));
        }, 15000);

        child.on('exit', (code) => {
            clearTimeout(timeout);
            setTimeout(() => {
                if (fs.existsSync(pdfPath)) {
                    fs.unlink(pdfPath, (err) => {
                        if (err) return; 
                        fs.rmdir(path.dirname(pdfPath), () => {});
                    });
                }
            }, 30000); // 30s dọn rác
            if (code === 0) resolve();
            else reject(new Error(`Lỗi SumatraPDF code ${code}`));
        });

        child.on('error', (err) => {
            clearTimeout(timeout);
            reject(new Error(`Không thể khởi chạy SumatraPDF: ${err.message}`));
        });
    });
}

// ─────────────────────────────────────────────
// LUỒNG 2: IN BẾP QUA LAN TRỰC TIẾP (ESC/POS)
// ─────────────────────────────────────────────
const removeAccents = (str) => {
    if (!str) return '';
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");
};

async function printKitchenThermal(data, isReturn = false, printerIpConfig) {
    let printer = new ThermalPrinter({
        type: PrinterTypes.EPSON,
        interface: printerIpConfig,
        characterSet: 'SLOVENIA',
        removeSpecialCharacters: false,
        // BẢO VỆ CỐT LÕI: Chờ 2.5s không kết nối được là bỏ qua ngay
        options: { timeout: 2500 } 
    });

    let title = '*** PHIEU ORDER ***';
    if (data.isTransfer || data.type === 'transfer') title = '*** PHIEU CHUYEN BAN ***';
    else if (isReturn) title = '*** PHIEU TRA MON ***';
    if (data.title) title = `*** ${removeAccents(data.title.toUpperCase())} ***`;

    printer.alignCenter();
    printer.bold(true);
    printer.setTextSize(1, 1);
    printer.println(title);
    printer.setTextNormal();
    printer.println(new Date().toLocaleString('vi-VN'));
    printer.drawLine();

    const tableText = data.area ? `BAN: ${data.table} (${data.area})` : `BAN: ${data.table}`;
    printer.bold(true);
    printer.setTextSize(1, 1);
    printer.println(removeAccents(tableText));
    printer.setTextNormal();
    printer.println(`Thu ngan: ${removeAccents(data.cashier || '')}`);
    printer.drawLine();

    if (data.isTransfer && data.fromTable && data.toTable) {
        printer.bold(true);
        printer.setTextSize(1, 1);
        printer.println(`TU BAN ${data.fromTable}  --->  BAN ${data.toTable}`);
        printer.setTextNormal();
        printer.bold(false);
        printer.drawLine();
    }

    printer.alignLeft();
    if (data.items && Array.isArray(data.items) && data.items.length > 0) {
        data.items.forEach(item => {
            const qty = item.qty || item.totalQty || 0;
            const itemName = removeAccents(item.name || item.TENHANG || '');
            const isReturnItem = isReturn || Number(qty) < 0;

            printer.bold(true);
            printer.setTextSize(1, 1);
            printer.println(`x${Math.abs(qty)} ${itemName}`);
            printer.setTextNormal();
            printer.bold(false);

            if (item.note) {
                printer.bold(true);
                printer.setTextSize(1, 0);
                printer.println(`  -> ${removeAccents(item.note)}`);
                printer.setTextNormal();
                printer.bold(false);
            }

            if (isReturnItem) printer.drawLine();
        });
    } else {
        const noteMsg = removeAccents(data.note || data.ghiChu || 'Chuyen toan bo ban');
        printer.println(`Ghi chu: ${noteMsg}`);
    }

    printer.drawLine();
    printer.partialCut();

    try {
        writeLog('PRINT', `→ Gửi ESC/POS tới ${printerIpConfig} | Bàn: ${data.table}`);
        await printer.execute();
        writeLog('PRINT', `✓ In ESC/POS thành công tại ${printerIpConfig}`);
    } catch (error) {
        throw new Error(`Mất kết nối LAN (${printerIpConfig}): ` + error.message);
    }
}

// ─────────────────────────────────────────────
// HÀM TẠO PDF
// ─────────────────────────────────────────────
async function createKitchenSlipPdf(data, isReturn = false) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace_k_'));
    const filePath = path.join(tmpDir, `order_${Date.now()}.pdf`);
    const doc = new PDFDocument({ margin: 10, size: [PAPER_WIDTH, 800] });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    if (fs.existsSync(FONT_PATH)) doc.registerFont('Regular', FONT_PATH);
    if (fs.existsSync(FONT_BOLD_PATH)) doc.registerFont('Bold', FONT_BOLD_PATH);
    doc.font('Regular');

    let title = '*** PHIẾU ORDER ***';
    if (data.isTransfer || data.type === 'transfer') title = '*** PHIẾU CHUYỂN BÀN ***';
    else if (isReturn) title = '*** PHIẾU TRẢ MÓN ***';
    if (data.title) title = `*** ${data.title.toUpperCase()} ***`;

    doc.font('Bold').fontSize(14).text(title, { align: 'center' });
    doc.font('Bold').fontSize(10).text(new Date().toLocaleString('vi-VN'), { align: 'center' });
    doc.moveDown(0.5);

    const tableText = data.area ? `BÀN: ${data.table} (${data.area})` : `BÀN: ${data.table}`;
    doc.font('Bold').fontSize(16).text(tableText, { align: 'center' });
    doc.font('Regular').fontSize(9).text(`Thu ngân: ${data.cashier || ''}`);
    doc.moveDown(0.3);
    doc.moveTo(10, doc.y).lineTo(PAPER_WIDTH - 10, doc.y).stroke();
    doc.moveDown();

    if (data.isTransfer && data.fromTable && data.toTable) {
        doc.font('Bold').fontSize(28).text(`TỪ BÀN ${data.fromTable}  --->  BÀN ${data.toTable}`, { align: 'center' });
        doc.moveDown(0.5);
        doc.moveTo(10, doc.y).lineTo(doc.page.width - 10, doc.y).stroke();
        doc.moveDown(0.5);
    }

    if (data.items && Array.isArray(data.items) && data.items.length > 0) {
        data.items.forEach(item => {
            const qty = item.qty || item.totalQty || 0;
            const itemName = item.name || item.TENHANG || '';
            const displayText = isReturn ? `x${Math.abs(qty)} [HỦY] ${itemName}` : `x${Math.abs(qty)} ${itemName}`;
            doc.font('Bold').fontSize(26).text(displayText, { strike: isReturn });
            if (item.note) doc.font('Bold').fontSize(10).text(`  -> ${item.note}`, { indent: 10 });
            doc.moveDown(0.4);
            if (isReturn) {
                doc.moveTo(10, doc.y).lineTo(PAPER_WIDTH - 10, doc.y).stroke();
                doc.moveDown(0.4);
            }
        });
    } else {
        const noteMsg = data.note || data.ghiChu || 'Chuyển toàn bộ bàn';
        doc.font('Regular').fontSize(12).text(`Ghi chú: ${noteMsg}`, { indent: 10 });
    }

    doc.end();
    return new Promise((res, rej) => {
        stream.on('finish', () => res(filePath));
        stream.on('error', (err) => rej(err));
    });
}

async function createBillPdf(data) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace_b_'));
    const filePath = path.join(tmpDir, `bill_${Date.now()}.pdf`);
    const MARGIN_LEFT = 8; const MARGIN_RIGHT = 18; const TOP_MARGIN = 20;
    const SAFE_PAPER_WIDTH = CONFIG.paperWidthMM === 80 ? 215 : 155;
    const CONTENT_WIDTH = SAFE_PAPER_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;

    const doc = new PDFDocument({
        margins: { top: TOP_MARGIN, bottom: 25, left: MARGIN_LEFT, right: MARGIN_RIGHT },
        size: [SAFE_PAPER_WIDTH, 1200]
    });

    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);
    if (fs.existsSync(FONT_PATH)) doc.registerFont('Regular', FONT_PATH);
    if (fs.existsSync(FONT_BOLD_PATH)) doc.registerFont('Bold', FONT_BOLD_PATH);
    doc.font('Regular');

    const billHeader = data.billInfo?.billHeaderName || data.branchName || 'ACE POS';
    doc.font('Bold').fontSize(14).text(billHeader, { align: 'center', width: CONTENT_WIDTH });
    if (data.billInfo?.address) doc.font('Regular').fontSize(9).text(data.billInfo.address, { align: 'center', width: CONTENT_WIDTH });
    if (data.billInfo?.phone) doc.font('Regular').fontSize(9).text(`ĐT: ${data.billInfo.phone}`, { align: 'center', width: CONTENT_WIDTH });

    doc.moveDown(0.5);

    let billTitle = 'PHIẾU TÍNH TIỀN';
    const printType = (data.type || '').toLowerCase();
    if (printType === 'provisional_bill') billTitle = 'PHIẾU TẠM TÍNH';
    else if (printType === 'payment_bill') billTitle = 'HÓA ĐƠN THANH TOÁN';
    else if (printType === 'inbill') {
        const hasPaymentMethod = data.paymentMethod && data.paymentMethod !== '';
        const cashTendered = Number(data.cashTendered || data.customerTendered || 0);
        billTitle = (hasPaymentMethod || cashTendered > 0) ? 'HÓA ĐƠN THANH TOÁN' : 'PHIẾU TẠM TÍNH';
    }

    doc.font('Bold').fontSize(16).text(billTitle, { align: 'center', width: CONTENT_WIDTH });
    doc.font('Bold').fontSize(14).text(`Bàn: ${data.table || '...'}`, { align: 'center', width: CONTENT_WIDTH });

    const now = new Date();
    const isProvisional = billTitle === 'PHIẾU TẠM TÍNH';
    doc.fontSize(10).text(`Ngày in: ${now.toLocaleDateString('vi-VN')} ${now.toLocaleTimeString('vi-VN')}`, { align: 'center', width: CONTENT_WIDTH });
    if (!isProvisional && data.giovao) doc.fontSize(10).text(`Giờ vào: ${data.giovao}`, { align: 'center', width: CONTENT_WIDTH });

    doc.moveDown(0.5);
    doc.moveTo(MARGIN_LEFT, doc.y).lineTo(SAFE_PAPER_WIDTH - MARGIN_RIGHT, doc.y).stroke();
    doc.moveDown(0.5);

    let subTotalCalculated = 0;
    if (data.items && Array.isArray(data.items)) {
        data.items.forEach(item => {
            const name = item.name || item.TENHANG || 'Món không tên';
            const price = Number(item.price || item.DONGIA || 0);
            const qty = Number(item.qty || item.totalQty || 0);
            const subtotal = price * qty;
            subTotalCalculated += subtotal;
            doc.font('Regular').fontSize(12).text(name, { width: CONTENT_WIDTH });
            doc.font('Bold').fontSize(11).text(`${qty} x ${price.toLocaleString()} = ${subtotal.toLocaleString()}`, { align: 'right', width: CONTENT_WIDTH });
            doc.moveDown(0.3);
        });
    }

    doc.moveDown(0.5);
    doc.moveTo(MARGIN_LEFT, doc.y).lineTo(SAFE_PAPER_WIDTH - MARGIN_RIGHT, doc.y).dash(2, { space: 2 }).stroke();
    doc.undash().moveDown(0.5);

    doc.font('Regular').fontSize(12).text(`Tổng phụ: ${subTotalCalculated.toLocaleString()}đ`, { align: 'right', width: CONTENT_WIDTH });
    const discountAmount = Number(data.discount || (data.discountInfo ? data.discountInfo.amount : 0) || 0);
    if (discountAmount !== 0) {
        doc.font('Regular').fontSize(12).text(
            `${discountAmount > 0 ? "Phụ thu:" : "Giảm giá:"} ${discountAmount > 0 ? "+" : "-"}${Math.abs(discountAmount).toLocaleString()}đ`,
            { align: 'right', width: CONTENT_WIDTH }
        );
    }

    const finalTotal = data.totalAmount ?? data.finalTotal ?? (subTotalCalculated + discountAmount);
    doc.moveDown(0.3);
    doc.font('Bold').fontSize(17).text(`TỔNG CỘNG: ${finalTotal.toLocaleString()}đ`, { align: 'right', width: CONTENT_WIDTH });

    if (billTitle === 'HÓA ĐƠN THANH TOÁN') {
        doc.moveDown(0.2);
        if (data.paymentMethod) doc.font('Regular').fontSize(12).text(`Thanh toán: ${data.paymentMethod}`, { align: 'right', width: CONTENT_WIDTH });
        const cashTendered = Number(data.cashTendered || data.customerTendered || 0);
        if (cashTendered > 0) {
            const changeAmount = Number(data.changeAmount || data.change || (cashTendered - finalTotal));
            doc.font('Regular').fontSize(12).text(`Khách đưa: ${cashTendered.toLocaleString()}đ`, { align: 'right', width: CONTENT_WIDTH });
            doc.font('Regular').fontSize(12).text(`Tiền thừa: ${changeAmount > 0 ? changeAmount.toLocaleString() : 0}đ`, { align: 'right', width: CONTENT_WIDTH });
        }
    }

    doc.moveDown(1);
    doc.font('Regular').fontSize(9).text(data.billInfo?.billFooterText || 'Cảm ơn Quý khách!', { align: 'center', width: CONTENT_WIDTH });
    doc.end();
    return new Promise((res, rej) => {
        stream.on('finish', () => res(filePath));
        stream.on('error', (err) => rej(err));
    });
}

// ─────────────────────────────────────────────
// LOGIC ĐIỀU PHỐI IN
// ─────────────────────────────────────────────
async function handlePrintLogic(data) {
    if (!data) return;

    const printType = (data.type || '').toLowerCase();
    const isBill = printType === 'inbill' || printType === 'provisional_bill' || printType === 'payment_bill';
    const isTransfer = data.isTransfer || printType === 'transfer' || (data.title && data.title.toLowerCase().includes('chuyển'));
    const hasItems = data.items && Array.isArray(data.items) && data.items.length > 0;

    if (isTransfer && hasItems) return;

    let isReturn = false;
    if (printType === 'return') {
        isReturn = true;
    } else if (hasItems) {
        isReturn = data.items.some(item => Number(item.qty || item.totalQty || 0) < 0);
    }

    let logType = isBill ? '\x1b[33m[BILL]\x1b[0m' : (isTransfer ? '\x1b[35m[CHUYỂN BÀN]\x1b[0m' : (isReturn ? '\x1b[31m[TRẢ MÓN]\x1b[0m' : '\x1b[32m[ORDER BẾP]\x1b[0m'));
    const logLabel = isBill ? 'BILL' : (isTransfer ? 'CHUYỂN' : (isReturn ? 'TRẢ' : 'BẾP'));
    console.log(`\n\x1b[36m[${new Date().toLocaleTimeString()}]\x1b[0m 📥 Xử lý: ${logType} - Bàn: ${data.table || 'N/A'}`);
    writeLog('PRINT', `━━ Đang in [${logLabel}] | Bàn: ${data.table || 'N/A'} | ${data.items?.length || 0} món`);

    try {
        if (isBill) {
            const pdfPath = await createBillPdf(data);
            const printerName = CONFIG.printers.default_bill || CONFIG.printers.default_kitchen;
            await printPdf(pdfPath, printerName);
            console.log(`   \x1b[32m[OK]\x1b[0m Đã in Hóa đơn: ${printerName}`);
        } else {
            if (!hasItems) {
                if (isTransfer || isReturn) {
                    const defaultKitchen = CONFIG.printers.default_kitchen;
                    if (defaultKitchen.startsWith("tcp://")) await printKitchenThermal(data, isReturn, defaultKitchen);
                    else {
                        const pdfPath = await createKitchenSlipPdf(data, isReturn);
                        await printPdf(pdfPath, defaultKitchen);
                    }
                    console.log(`   \x1b[32m[OK]\x1b[0m Đã in phiếu nguyên bàn [${isTransfer ? 'CHUYỂN' : 'TRẢ/HỦY'}]`);
                }
                return;
            }

            const printers = {};
            const configPrintersUpper = {};
            for (const k in CONFIG.printers) configPrintersUpper[k.trim().toUpperCase()] = CONFIG.printers[k];

            data.items.forEach(item => {
                let cat = String(item.muc || item.MUC || item.nhom || item.NHOM || "").trim().toUpperCase();
                if (configPrintersUpper[cat]) {
                    const pName = configPrintersUpper[cat];
                    if (!printers[pName]) printers[pName] = { ...data, items: [] };
                    printers[pName].items.push(item);
                }
            });

            let hasError = false;
            let lastError = null;
            let unprintedItems = []; 

            for (const pName in printers) {
                const printerData = printers[pName];
                const isTcpPrinter = pName.startsWith("tcp://");
                const isPrintOneItem = (data.branchConfig && data.branchConfig.printOneItemPerSlip) || globalBranchConfig.printOneItemPerSlip;

                if (isReturn) {
                    try {
                        if (isTcpPrinter) await printKitchenThermal(printerData, true, pName);
                        else {
                            const pdfPath = await createKitchenSlipPdf(printerData, true);
                            await printPdf(pdfPath, pName);
                        }
                        console.log(`   \x1b[32m[OK]\x1b[0m Trả món tại: ${pName}`);
                    } catch (err) {
                        hasError = true; lastError = err;
                        unprintedItems.push(...printerData.items);
                    }
                } else {
                    if (isPrintOneItem === true) {
                        for (const item of printerData.items) {
                            try {
                                if (isTcpPrinter) await printKitchenThermal({ ...printerData, items: [item] }, false, pName);
                                else {
                                    const pdfPath = await createKitchenSlipPdf({ ...printerData, items: [item] }, false);
                                    await printPdf(pdfPath, pName);
                                }
                                console.log(`   \x1b[32m[OK]\x1b[0m In món tại: ${pName}`);
                            } catch (err) {
                                hasError = true; lastError = err;
                                unprintedItems.push(item); 
                            }
                        }
                    } else {
                        try {
                            if (isTcpPrinter) await printKitchenThermal(printerData, false, pName);
                            else {
                                const pdfPath = await createKitchenSlipPdf(printerData, false);
                                await printPdf(pdfPath, pName);
                            }
                            console.log(`   \x1b[32m[OK]\x1b[0m In món tại: ${pName}`);
                        } catch (err) {
                            hasError = true; lastError = err;
                            unprintedItems.push(...printerData.items); 
                        }
                    }
                }
            }

            if (hasError) {
                data.items = unprintedItems; 
                throw lastError; 
            }
        }
    } catch (err) {
        throw err;
    }
}

// ─────────────────────────────────────────────
// CHẠY HÀNG ĐỢI (ĐÃ FIX MẤT PHIẾU & LOCK FIREBASE DELETE)
// ─────────────────────────────────────────────
let db;
let lastFailTime = 0;

const processPrintQueue = async () => {
    if (isPrinting || localPrintQueue.length === 0) return;
    isPrinting = true;

    while (localPrintQueue.length > 0) {
        const { docRef, job, docId } = localPrintQueue.shift();

        // --- 1. LỆNH TỪ API LOCAL ---
        if (!docRef) {
            try {
                await handlePrintLogic(job);
                printedIds.add(docId); 
            } catch (err) {
                console.error(`   \x1b[31m[LỖI MẠNG LAN]\x1b[0m Lệnh nội bộ ${docId} - ${err.message}`);
                const retryCount = (job._retryCount || 0) + 1;
                
                // GIỚI HẠN 3 LẦN THỬ LẠI ĐỂ BẢO VỆ HỆ THỐNG
                if (retryCount <= 3) {
                    const delay = 5000; 
                    console.log(`   \x1b[33m[ĐANG CHỜ MÁY IN]\x1b[0m Hẹn in lại phiếu LAN (lần ${retryCount}/3) sau ${delay/1000}s...`);
                    writeLog('RETRY', `Chờ máy in Local ${docId} | Lần ${retryCount} | Thử lại sau ${delay/1000}s`);

                    setTimeout(() => {
                        enqueuedIds.delete(docId);
                        localPrintQueue.push({ docRef: null, job: { ...job, _retryCount: retryCount }, docId });
                        enqueuedIds.add(docId);
                        processPrintQueue(); 
                    }, delay);
                } else {
                    console.error(`   \x1b[31m[HỦY PHIẾU]\x1b[0m Máy in bếp lỗi mạng. Đã HỦY lệnh ${docId} để hệ thống tiếp tục in Bill.`);
                    writeLog('ERROR', `Hủy phiếu Local ${docId} do thử 3 lần không được.`);
                }
            }
            await new Promise(res => setTimeout(res, 250)); 
            continue;
        }

        // --- 2. LỆNH TỪ FIREBASE (APP ORDER) ---
        if (!db) continue;
        let shouldPrint = false;

        try {
            shouldPrint = await runTransaction(db, async (tx) => {
                const snap = await tx.get(docRef);
                if (!snap.exists() || snap.data().status !== 'pending') return false;
                tx.update(docRef, { status: 'printing' });
                return true;
            });

            if (!shouldPrint) continue;

            // Xử lý in vật lý
            await handlePrintLogic(job);

            printedIds.add(docId);
            writeLog('QUEUE', `✓ Đã in ra giấy doc ${docId}`);

            try {
                await deleteDoc(docRef);
            } catch (deleteErr) {
                console.error(`   \x1b[33m[CẢNH BÁO]\x1b[0m Rớt mạng khi xóa Firebase ${docId}. Đã khóa in lại.`);
            }

        } catch (err) {
            console.error("   \x1b[31m[LỖI XỬ LÝ FIREBASE]\x1b[0m", err.message);
            writeLog('ERROR', `Lỗi máy in với doc Firebase ${docId} | ${err.message}`);
            lastFailTime = Date.now();

            if (shouldPrint) {
                const retryCount = (job._retryCount || 0) + 1;
                
                // GIỚI HẠN 3 LẦN THỬ LẠI ĐỂ BẢO VỆ HỆ THỐNG
                if (retryCount <= 3) {
                    const delay = 5000;
                    console.log(`   \x1b[33m[ĐANG CHỜ MÁY IN]\x1b[0m Hẹn in lại doc ${docId} (lần ${retryCount}/3) sau ${delay/1000}s...`);
                    writeLog('RETRY', `Chờ máy in Firebase doc ${docId} | Lần ${retryCount} | Thử lại sau ${delay/1000}s`);

                    updateDoc(docRef, { status: 'pending', _retryCount: retryCount, lastError: err.message }).catch(()=>{});

                    setTimeout(() => {
                        enqueuedIds.delete(docId);
                        localPrintQueue.push({ docRef, job: { ...job, _retryCount: retryCount }, docId });
                        enqueuedIds.add(docId);
                        processPrintQueue();
                    }, delay);
                } else {
                    console.error(`   \x1b[31m[HỦY PHIẾU KHỎI HÀNG ĐỢI]\x1b[0m Đã chuyển doc ${docId} thành FAILED để hệ thống không bị kẹt.`);
                    updateDoc(docRef, { status: 'failed', lastError: 'Quá thời gian chờ máy in' }).catch(()=>{});
                }
            }
        } finally {
            await new Promise(res => setTimeout(res, 250));
        }
    }
    isPrinting = false;
};

// ─────────────────────────────────────────────
// API ENDPOINT
// ─────────────────────────────────────────────
app.post('/print', (req, res) => {
    try {
        const docId = 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
        localPrintQueue.push({ docRef: null, job: req.body, docId });
        writeLog('API', `Nhận lệnh in Local mạng LAN - Mã: ${docId}`);
        processPrintQueue(); 
        res.json({ success: true, message: "Đã đưa vào hàng đợi in cục bộ" }); 
    }
    catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─────────────────────────────────────────────
// FIREBASE LISTENER & RECOVERY
// ─────────────────────────────────────────────
if (CONFIG.firebaseConfig && CONFIG.shopInfo) {
    const firebaseApp = initializeApp(CONFIG.firebaseConfig);
    db = getFirestore(firebaseApp);
    const branchPath = `customers/${CONFIG.shopInfo.customerId}/branches/${CONFIG.shopInfo.branchId}`;
    const queuePath = `${branchPath}/print_queue`;

    onSnapshot(doc(db, branchPath), (docSnap) => {
        if (docSnap.exists()) globalBranchConfig = docSnap.data().config || docSnap.data() || {};
    });

    const recoverPendingJobs = async () => {
        try {
            console.log('\x1b[33m🔄 Đang kiểm tra và dọn dẹp dữ liệu tồn đọng...\x1b[0m');
            const today = new Date().toDateString();

            // 1. Quét những lệnh đang in dở (printing) bị đứt do tắt Tool ngang
            const snapPrinting = await getDocs(query(collection(db, queuePath), where("status", "==", "printing")));
            for (const docSnap of snapPrinting.docs) {
                // Trả về pending để nó thử in lại 3 lần chuẩn chỉnh
                await updateDoc(docSnap.ref, { status: 'pending', _retryCount: 0 });
            }

            // 2. Quét những lệnh lỗi từ rất lâu (failed) hoặc khác ngày
            const snapFailed = await getDocs(query(collection(db, queuePath), where("status", "==", "failed")));
            for (const docSnap of snapFailed.docs) {
                const data = docSnap.data();
                const createdAt = data.createdAt?.toDate?.() || data._createdAt;
                const docDay = createdAt ? new Date(createdAt).toDateString() : today;
                
                // Tránh tốn bộ nhớ, hóa đơn rác từ hôm qua là xóa thẳng tay
                if (docDay !== today) {
                    await deleteDoc(docSnap.ref);
                }
            }

            console.log('   ✅ Đã dọn dẹp xong. Tool đã sẵn sàng nhận Order!');

            // Quét lại toàn bộ hàng đợi chuẩn bị in
            const snapPending = await getDocs(query(collection(db, queuePath), where("status", "==", "pending")));
            let count = 0;
            snapPending.docs.forEach((docSnap) => {
                const docId = docSnap.id;
                if (enqueuedIds.has(docId) || printedIds.has(docId)) return;
                enqueuedIds.add(docId);
                localPrintQueue.push({ docRef: docSnap.ref, job: docSnap.data(), docId });
                count++;
            });

            if (count > 0) {
                console.log(`   \x1b[33m⚠️  Tìm thấy ${count} phiếu chờ, đang xử lý nhanh...\x1b[0m`);
                processPrintQueue();
            }

        } catch (err) {
            console.error('Lỗi lúc khởi động:', err.message);
        }
    };

    onSnapshot(query(collection(db, queuePath), where("status", "==", "pending")), (snap) => {
        let hasNew = false;
        snap.docChanges().forEach((change) => {
            if (change.type === "added" || change.type === "modified") {
                const docId = change.doc.id;
                if (enqueuedIds.has(docId) || printedIds.has(docId)) return;
                enqueuedIds.add(docId);
                localPrintQueue.push({ docRef: change.doc.ref, job: change.doc.data(), docId });
                hasNew = true;
            }
        });
        if (hasNew) processPrintQueue();
    });

    // Chờ 5s để hệ thống kết nối mạng đầy đủ rồi mới làm nhiệm vụ
    setTimeout(recoverPendingJobs, 5000); 

    // Dự phòng an toàn: 30s check lại một lần phòng hờ rớt Firebase
    setInterval(async () => {
        const hasRecentFail = (Date.now() - lastFailTime) < 5 * 60 * 1000;
        if (localPrintQueue.length > 0 || isPrinting) return;
        if (!hasRecentFail) return;
        try {
            const snap = await getDocs(query(collection(db, queuePath), where("status", "==", "pending")));
            if (snap.empty) return;
            let count = 0;
            snap.docs.forEach(docSnap => {
                const docId = docSnap.id;
                if (enqueuedIds.has(docId) || printedIds.has(docId)) return;
                enqueuedIds.add(docId);
                localPrintQueue.push({ docRef: docSnap.ref, job: docSnap.data(), docId });
                count++;
            });
            if (count > 0) processPrintQueue();
        } catch(e) {}
    }, 30000);
}

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.clear();
    console.log('\x1b[32mACE POS PRINT SERVER STARTED (FINAL STABLE VERSION)\x1b[0m');
    console.log(`> Cổng: ${PORT} | Giấy: ${CONFIG.paperWidthMM}mm`);
    console.log(`> Anti-Phantom Loop: \x1b[32mBẬT\x1b[0m | Smart Retry: \x1b[32mGiới hạn 3 lần an toàn\x1b[0m`);
    writeLog('SYSTEM', `════════════════════════════════════════`);
    writeLog('SYSTEM', `SERVER KHỞI ĐỘNG | Cổng: ${PORT} | Giấy: ${CONFIG.paperWidthMM}mm`);
    writeLog('SYSTEM', `Máy in bếp: ${CONFIG.printers.default_kitchen}`);
    writeLog('SYSTEM', `Máy in bill: ${CONFIG.printers.default_bill}`);
    writeLog('SYSTEM', `════════════════════════════════════════`);
});