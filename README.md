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
