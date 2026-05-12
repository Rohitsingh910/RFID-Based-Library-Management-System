# finalpUI

Minimal manual SIP2 check-in app.

## Run

```bash
cd finalpUI
npm start
```

Open `http://localhost:3000`.

## Flow

1. Press `Check-In`
2. Type the book number
3. Submit the form
4. The backend logs into `164.52.208.94:8023`
5. It sends the SIP2 `09` check-in command
6. A successful `10` response marks the item as checked in


# 📚 RFID-Based Library Management System

An RFID-enabled Self-Service Library Kiosk integrated with **Koha ILS** using the **SIP2 protocol**, built with **Electron.js and Node.js**.

This system allows patrons to independently perform:

- ✅ Book Check-out (Multi-book supported)
- ✅ Book Check-in
- ✅ Renew Items
- ✅ My Account Lookup
- ✅ Manual Patron Entry
- ✅ RFID Scanning
- ✅ Thermal Receipt Printing
- ✅ Manual & Automatic Email Receipts
- ✅ Inactivity Timeout (Auto Reset to Home)

---

## 🚀 Key Features

- Multi-book checkout in a single session
- SIP2 integration with Koha ILS
- RFID hardware integration
- Thermal printer support
- Manual fallback entry for patron and items
- Structured error handling
- Session inactivity timeout (30 sec auto reset)
- Source code protection for production builds
- Production-ready Windows installer build

---

## 🏗️ Architecture Overview

Electron Frontend (UI)
↓
Node.js Backend
↓
SIP2 Protocol
↓
Koha ILS Server
↓
RFID + Printer Hardware


---

## 🛠️ Tech Stack

- Electron.js
- Node.js
- SIP2 Protocol
- Koha ILS (v24)
- RFID Integration
- HTML / CSS / JavaScript
- Winston Logging
- Nodemailer (Manual Email)
- Git Version Control

---

## 🔐 Security Measures

- SIP2 credential protection
- Source code obfuscation for production
- ASAR packaging
- Environment variable configuration
- No credentials committed to repository

---

## 🧪 Testing

- 50+ structured manual test cases
- End-to-end checkout & check-in validation
- RFID and hardware error handling verification
- Koha connectivity failure testing

---

## 📦 Installation (Development)

```bash
npm install
npm start
npm run electron


## 👨‍💻 Author

Rohit Singh  
RFID & Koha Integration Developer  

![rfid connection](rfid.png)
 ![Home page](image.png)
  ![check-out](check-out.png)
   ![check-in](check-in.png)
    ![my account](my account.png)
     ![renew](renew.png)
      ![renew item](renew item.png)