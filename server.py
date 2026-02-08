import yaml  # Requires pip install pyyaml
import json
import os
import subprocess
import sqlite3
import requests
import uvicorn
from fastapi import FastAPI, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional

app = FastAPI()

# --- Configuration ---
UNFOLD_BINARY = "./unfold/unfold"
UNFOLD_CONFIG = "./unfold_config.yaml"  # Local config file
DB_PATH = "./unfold/db.sqlite"   # Default DB path
HOLDINGS_FILE = "./holdings.json"

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Helpers ---
def load_holdings():
    if os.path.exists(HOLDINGS_FILE):
        try:
            with open(HOLDINGS_FILE, "r") as f:
                return json.load(f)
        except:
            return []
    return []

def save_holdings(holdings):
    with open(HOLDINGS_FILE, "w") as f:
        json.dump(holdings, f)

def save_unfold_config(access_token, refresh_token, uuid):
    config = {
        "token": {
            "access": access_token,
            "refresh": refresh_token
        },
        "fold_user": {
            "uuid": uuid
        },
        "device_hash": "python-client-" + os.urandom(4).hex()
    }
    with open(UNFOLD_CONFIG, "w") as f:
        yaml.dump(config, f)

def get_unfold_token():
    if os.path.exists(UNFOLD_CONFIG):
        try:
            with open(UNFOLD_CONFIG, "r") as f:
                config = yaml.safe_load(f)
                return config.get('token', {}).get('access')
        except:
            return None
    return None

# --- Models ---
class Transaction(BaseModel):
    uuid: str
    amount: float
    timestamp: str
    merchant: str
    
class Holding(BaseModel):
    scheme_code: str
    units: float

class LoginRequest(BaseModel):
    phone: str

class VerifyRequest(BaseModel):
    phone: str
    otp: str

# --- Endpoints ---

# 1. Auth (Login/Verify)
@app.post("/api/fold/login")
def fold_login(req: LoginRequest):
    url = "https://api.fold.money/v1/auth/otp"
    # Format phone to +91... if not present
    phone = req.phone
    if not phone.startswith("+"):
        phone = "+91" + phone
        
    payload = {"phone": phone, "channel": "sms"}
    try:
        res = requests.post(url, json=payload)
        res.raise_for_status()
        return {"status": "otp_sent"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/fold/verify")
def fold_verify(req: VerifyRequest):
    url = "https://api.fold.money/v1/auth/otp/verify"
    phone = req.phone
    if not phone.startswith("+"):
        phone = "+91" + phone

    payload = {"phone": phone, "otp": req.otp}
    try:
        res = requests.post(url, json=payload)
        res.raise_for_status()
        data = res.json().get("data", {})
        
        access = data.get("access_token")
        refresh = data.get("refresh_token")
        uuid = data.get("user_meta", {}).get("uuid")
        
        if access and refresh:
            save_unfold_config(access, refresh, uuid)
            return {"status": "success"}
        else:
            raise HTTPException(status_code=400, detail="Invalid response from Fold")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Verification failed: {str(e)}")

@app.get("/api/fold/status")
def fold_status():
    token = get_unfold_token()
    return {"logged_in": token is not None}

# 2. Holdings Management
@app.get("/api/holdings")
def get_holdings_api():
    return load_holdings()

@app.post("/api/holdings")
def set_holdings_api(holdings: List[Holding]):
    data = [{"scheme_code": h.scheme_code, "units": h.units} for h in holdings]
    save_holdings(data)
    return {"status": "updated"}

# 3. Transactions (Main Feature)
@app.get("/api/transactions")
def get_transactions():
    """Fetches transactions from the Unfold SQLite DB."""
    if not os.path.exists(DB_PATH) or get_unfold_token():
        # Try to run unfold to generate DB if it doesn't exist OR if we have a token (to update)
        # Actually, let's only auto-run if DB is missing. Sync should be manual or periodic.
        if not os.path.exists(DB_PATH):
             try:
                subprocess.run([UNFOLD_BINARY, "transactions", "--db", "--config", UNFOLD_CONFIG], check=True)
             except:
                pass # Might fail if not logged in

    if not os.path.exists(DB_PATH):
        return []

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='transactions'")
        if not cursor.fetchone():
             return []

        cursor.execute("SELECT uuid, amount, current_balance, timestamp, type, account, merchant FROM transactions ORDER BY timestamp DESC LIMIT 50")
        rows = cursor.fetchall()
        
        results = []
        for row in rows:
            results.append({
                "uuid": row[0],
                "amount": row[1],
                "current_balance": row[2],
                "timestamp": row[3],
                "type": row[4],
                "account": row[5],
                "merchant": row[6]
            })
        return results
    except Exception as e:
        print(f"DB Error: {e}")
        return []
    finally:
        conn.close()

@app.post("/api/sync")
def sync_transactions():
    try:
        subprocess.run([UNFOLD_BINARY, "transactions", "--db", "--config", UNFOLD_CONFIG], check=True)
        return {"status": "success"}
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=500, detail="Failed to sync. Ensure you are logged in.")
    except Exception as e:
         raise HTTPException(status_code=500, detail=str(e))

# 4. Portfolio (Calculated)
@app.get("/api/portfolio")
def get_portfolio():
    total_value = 0
    portfolio = []
    
    holdings = load_holdings()
    
    for holding in holdings:
        code = holding["scheme_code"]
        units = float(holding["units"])
        
        try:
            resp = requests.get(f"https://api.mfapi.in/mf/{code}")
            data = resp.json()
            if data and "data" in data and len(data["data"]) > 0:
                nav = float(data["data"][0]["nav"])
                fund_name = data["meta"]["scheme_name"]
                value = units * nav
                
                portfolio.append({
                    "scheme_code": code,
                    "scheme_name": fund_name,
                    "units": units,
                    "nav": nav,
                    "current_value": round(value, 2)
                })
                total_value += value
        except Exception as e:
            print(f"Error fetching {code}: {e}")
            
    return {
        "portfolio": portfolio,
        "total_value": round(total_value, 2)
    }

# Mount static files (Frontend)
app.mount("/", StaticFiles(directory=".", html=True), name="static")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
