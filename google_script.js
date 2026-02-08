// ******************************************************
// GOOGLE APPS SCRIPT FOR GEORGE FINANCE
// ******************************************************
// Instructions:
// 1. Open your Google Sheet
// 2. Go to Extensions > Apps Script
// 3. Paste this code entirely
// 4. Save and Deploy as Web App (Execute as Me, Anyone can access)
// 5. Copy the Web App URL into the Frontend Code

const SCRIPT_PROP = PropertiesService.getScriptProperties();

// *** CONFIG: YOUR SPECIFIC SHEET ID ***
const SHEET_ID = "1u8avtUDehdZYSDDbIv0hoVyhBorUDptZDFh3ngp1gLo";

function getTargetSheet() {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    return ss.getSheets()[0];
}

// *** NEW HELPER: CALCULATE BALANCE IN SCRIPT ***
function calculateBalance(sheet) {
    const data = sheet.getDataRange().getValues();
    let bal = 0;
    // Start loop from 1 to skip Header row
    for (let i = 1; i < data.length; i++) {
        const amount = parseFloat(data[i][2]); // Column C is Amount
        const type = data[i][4]; // Column E is Type

        if (!isNaN(amount)) {
            if (type === 'CREDIT') {
                bal += amount;
            } else {
                bal -= amount; // Assume DEBIT or blank is expense
            }
        }
    }
    return bal;
}

function doGet() {
    const sheet = getTargetSheet();
    const data = sheet.getDataRange().getValues();

    // *** CHANGE 1: Use helper instead of H1 ***
    const balance = calculateBalance(sheet);

    const budget = SCRIPT_PROP.getProperty("DAILY_BUDGET") || 350;

    // *** FIXED: DEFAULTS TO TRUE (MASKING ON) IF NO SETTING FOUND ***
    const privacyRaw = SCRIPT_PROP.getProperty("PRIVACY_MODE");
    const privacy = privacyRaw === null ? true : (privacyRaw === "true");

    const expenses = [];
    const startRow = Math.max(1, data.length - 50);
    for (let i = startRow; i < data.length; i++) {
        if (data[i][0]) {
            expenses.push({
                date: data[i][0],
                description: data[i][1],
                amount: data[i][2],
                category: data[i][3],
                type: data[i][4]
            });
        }
    }

    return ContentService.createTextOutput(JSON.stringify({
        balance: balance,
        expenses: expenses,
        budget: budget,
        privacy: privacy
    })).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
    const sheet = getTargetSheet();
    const body = JSON.parse(e.postData.contents);
    const geminiKey = SCRIPT_PROP.getProperty("GEMINI_KEY");

    // --- 1. SAVE SETTINGS ---
    if (body.action === "save_settings") {
        SCRIPT_PROP.setProperty("DAILY_BUDGET", body.budget.toString());
        SCRIPT_PROP.setProperty("PRIVACY_MODE", body.privacy.toString());
        if (body.geminiKey) SCRIPT_PROP.setProperty("GEMINI_KEY", body.geminiKey);
        return ContentService.createTextOutput(JSON.stringify({ status: "Saved" })).setMimeType(ContentService.MimeType.JSON);
    }

    // --- 2. DELETE TRANSACTION ---
    if (body.action === "delete") {
        const data = sheet.getDataRange().getValues();
        for (let i = data.length - 1; i >= 0; i--) {
            if (data[i][1] === body.description && data[i][2] == body.amount) {
                sheet.deleteRow(i + 1);

                // *** CHANGE 2: Recalculate balance ***
                const newBalance = calculateBalance(sheet);

                return ContentService.createTextOutput(JSON.stringify({ status: "Deleted", balance: newBalance })).setMimeType(ContentService.MimeType.JSON);
            }
        }
        return ContentService.createTextOutput(JSON.stringify({ status: "Not Found" })).setMimeType(ContentService.MimeType.JSON);
    }

    // --- 3. BASE "ADD" (Legacy/Postman Support) ---
    if (body.action === "add") {
        const date = new Date();
        const type = (body.type === 'income' || body.category === 'Income') ? 'CREDIT' : 'DEBIT';
        sheet.appendRow([date, body.description, body.amount, body.category, type]);

        // *** CHANGE 3: Recalculate balance ***
        const newBalance = calculateBalance(sheet);

        return ContentService.createTextOutput(JSON.stringify({
            status: "Success",
            balance: newBalance,
            parsed: { date: date, description: body.description, amount: body.amount, category: body.category, type: type }
        })).setMimeType(ContentService.MimeType.JSON);
    }

    // --- 4. AI PROCESSING (New Features) ---
    if (body.action === "process_text") {
        const userText = body.text;
        const mode = body.mode;

        // Fetch Context
        const historyData = sheet.getRange(Math.max(1, sheet.getLastRow() - 40), 1, 41, 4).getValues();
        const historyContext = historyData.map(r => `${r[1]} (${r[2]}) [${r[3]}]`).join("\n");

        let prompt = "";
        if (mode === 'add') {
            prompt = `
      You are a financial assistant. 
      CONTEXT: The user wants to ADD a transaction.
      USER INPUT: "${userText}"
      HISTORY: 
      ${historyContext}
      
      TASK:
      1. Extract: Description, Amount, Category (Food, Transport, Tech, Invest, Income, Misc).
      2. Analyze: Compare this new expense to the HISTORY. Is it higher than usual? Is it a repeat?
      3. Insight: Write a very short, witty, or helpful insight (max 15 words) about this specific spend.
      
      OUTPUT JSON STRICTLY:
      {
        "description": "String",
        "amount": Number,
        "category": "String",
        "type": "DEBIT" or "CREDIT",
        "insight": "String"
      }
      `;
        } else {
            prompt = `
      You are a financial analyst.
      CONTEXT: The user is ASKING a question about their finances.
      USER INPUT: "${userText}"
      HISTORY: 
      ${historyContext}
      
      TASK: 
      Answer the user's question based strictly on the HISTORY data provided. Be concise (max 30 words).
      
      OUTPUT JSON STRICTLY:
      {
        "answer": "String"
      }
      `;
        }

        // *** USES GEMINI FLASH LATEST (DYNAMIC FREE MODEL) ***
        const geminiKey = SCRIPT_PROP.getProperty("GEMINI_KEY");
        const aiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${geminiKey}`;
        const aiPayload = { contents: [{ parts: [{ text: prompt }] }] };

        try {
            const aiRes = UrlFetchApp.fetch(aiUrl, { method: 'post', contentType: 'application/json', payload: JSON.stringify(aiPayload) });
            const aiJson = JSON.parse(aiRes.getContentText());
            const rawText = aiJson.candidates[0].content.parts[0].text;
            const cleanJson = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(cleanJson);

            if (mode === 'add') {
                const date = new Date();
                const type = parsed.type || 'DEBIT'; // Default to DEBIT if AI misses it
                sheet.appendRow([date, parsed.description, parsed.amount, parsed.category, type]);

                // *** CHANGE 4: Recalculate balance ***
                const newBalance = calculateBalance(sheet);

                return ContentService.createTextOutput(JSON.stringify({
                    status: "Success",
                    balance: newBalance,
                    parsed: { ...parsed, date: date },
                    ai_response: `Saved. ${parsed.insight || ""}`
                })).setMimeType(ContentService.MimeType.JSON);

            } else {
                return ContentService.createTextOutput(JSON.stringify({
                    status: "Success",
                    ai_response: parsed.answer
                })).setMimeType(ContentService.MimeType.JSON);
            }

        } catch (e) {
            return ContentService.createTextOutput(JSON.stringify({ status: "Error", message: "AI Failed: " + e.message })).setMimeType(ContentService.MimeType.JSON);
        }
    }
}
