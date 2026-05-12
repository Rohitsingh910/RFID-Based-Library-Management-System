# Punjabi University Library Kiosk - Manual Test Cases

Use this checklist after starting the app from the latest build or installer. Mark each case as Pass/Fail during testing.

| # | Area | Test Case | Steps | Expected Result | Status |
|---|------|-----------|-------|-----------------|--------|
| 1 | Startup | App launches successfully | Open the installed kiosk app. | Splash screen appears, then Home screen opens without crash. | Pass / Fail |
| 2 | Startup | Server starts with app | Launch app and wait for Home screen. | Backend is reachable and no offline screen appears. | Pass / Fail |
| 3 | Startup | Home buttons visible | Open Home screen. | Checkout, Check-In, Renew, and Account buttons are visible. | Pass / Fail |
| 4 | Startup | Close button behavior | Click the close/exit control if available. | App closes normally without hanging. | Pass / Fail |
| 5 | Check-In | Open check-in flow | From Home, click Check-In. | Check-in screen opens and shows item placement/start scan flow. | Pass / Fail |
| 6 | Check-In | Start scanning | Click Start Scanning. | Scanning UI appears and Done button is visible. | Pass / Fail |
| 7 | Check-In | Valid manual barcode | Enter a valid checked-out item barcode manually and submit. | Item checks in successfully and one success card appears. | Pass / Fail |
| 8 | Check-In | Valid RFID item | Place one valid checked-out RFID book on reader. | Item checks in once and success card appears once. | Pass / Fail |
| 9 | Check-In | Unknown manual barcode | Enter an invalid/unknown barcode and submit. | UI shows `Invalid item` once only; no retry text appears. | Pass / Fail |
| 10 | Check-In | Unknown RFID book | Place an unknown RFID book/tag on reader. | UI shows `Invalid item` once only for that item. | Pass / Fail |
| 11 | Check-In | Unknown book remains on reader | Keep the same unknown RFID book on reader for 10 seconds. | It does not keep adding repeated invalid cards. | Pass / Fail |
| 12 | Check-In | Retry still works for transient failure | Temporarily disconnect network/SIP server and scan valid item. | App retries according to config and shows connection/transaction error if still failing. | Pass / Fail |
| 13 | Check-In | Duplicate valid RFID appearance | Keep same valid RFID book on reader after success. | Same barcode is not checked in repeatedly in the same session. | Pass / Fail |
| 14 | Check-In | Multiple valid books | Place two valid checked-out RFID books one after another. | Each book gets one success card and count increments correctly. | Pass / Fail |
| 15 | Check-In | Mixed valid and invalid books | Scan one valid item and one unknown item. | Valid item succeeds; unknown item shows `Invalid item`; both results remain separate. | Pass / Fail |
| 16 | Check-In | Done with successful items | After at least one successful check-in, click Done. | Check-in success/thank-you screen appears and receipt options work as designed. | Pass / Fail |
| 17 | Check-In | Done with zero successful items | Open Check-In and click Done without successful check-in. | User is returned appropriately without printing empty receipt. | Pass / Fail |
| 18 | Check-In | Check-in receipt content | Complete check-in and print/preview receipt. | Receipt contains returned item title/barcode and return date. | Pass / Fail |
| 19 | Check-In | Security write success | Check in RFID item with reader connected. | Item checks in and RFID security update does not show warning. | Pass / Fail |
| 20 | Check-In | Security write failure does not fail return | Make RFID security write unavailable after SIP success. | Check-in still succeeds, with security warning if applicable. | Pass / Fail |
| 21 | Checkout | Open checkout flow | From Home, click Checkout. | Patron scan/entry screen opens. | Pass / Fail |
| 22 | Checkout | Valid patron card | Scan or enter a valid patron card. | App advances to book scan screen. | Pass / Fail |
| 23 | Checkout | Invalid patron card | Scan or enter an unknown patron card. | User-friendly card not recognized error appears. | Pass / Fail |
| 24 | Checkout | Valid item checkout | With valid patron active, scan a valid available item. | Item checks out successfully and appears in session list. | Pass / Fail |
| 25 | Checkout | Unknown checkout item | With valid patron active, scan unknown item barcode/tag. | Item not found/invalid item style error appears without success. | Pass / Fail |
| 26 | Checkout | Duplicate checkout item | Scan same checkout item twice in one session. | Duplicate is skipped or shown as already processed, not issued twice. | Pass / Fail |
| 27 | Checkout | Already issued item | Try checkout for an item already issued to someone else. | Checkout fails with user-friendly transaction/issued error. | Pass / Fail |
| 28 | Checkout | Multiple item checkout | Checkout two or more available items for same patron. | All successful items appear in session list with due dates. | Pass / Fail |
| 29 | Checkout | Finish checkout | Complete checkout and click finished/done. | Thank-you or final screen appears correctly. | Pass / Fail |
| 30 | Checkout | Checkout receipt | Print/preview checkout receipt. | Receipt contains patron and checked-out book details with due dates. | Pass / Fail |
| 31 | Renew | Open renew flow | From Home, click Renew. | Renew patron scan screen opens. | Pass / Fail |
| 32 | Renew | Valid patron renew lookup | Scan or enter valid patron card in Renew. | Items-out list loads for that patron. | Pass / Fail |
| 33 | Renew | Invalid patron renew lookup | Enter unknown patron card in Renew. | User-friendly patron not found/card error appears. | Pass / Fail |
| 34 | Renew | No renewable books | Use patron with no renewable items. | App shows no renewable items message and does not crash. | Pass / Fail |
| 35 | Renew | Select all renewable items | On renew item list, click Select All. | All renewable item checkboxes become selected. | Pass / Fail |
| 36 | Renew | Clear all selections | Click Clear All. | All selected renewable item checkboxes become unselected. | Pass / Fail |
| 37 | Renew | Renew selected item | Select one renewable item and submit. | Item renews successfully and result shows new due date. | Pass / Fail |
| 38 | Renew | Renew multiple items | Select multiple renewable items and submit. | Each item gets its own success/failure result. | Pass / Fail |
| 39 | Renew | Non-renewable item display | Use patron with non-renewable item. | Non-renewable section shows item with reason/status. | Pass / Fail |
| 40 | Renew | Renew receipt | Complete renew and choose receipt option. | Receipt contains renewed items and new due dates. | Pass / Fail |
| 41 | Account | Open account flow | From Home, click Account. | Account card entry/scan screen opens. | Pass / Fail |
| 42 | Account | Valid account lookup | Enter or scan valid patron card. | Account summary loads with patron details, fines, loans, and holds if present. | Pass / Fail |
| 43 | Account | Invalid account lookup | Enter unknown patron card. | User-friendly card/patron not found error appears. | Pass / Fail |
| 44 | Account | Account with no loans | Look up patron with no issued books. | Empty issued-books state appears correctly. | Pass / Fail |
| 45 | Account | Account overdue display | Look up patron with overdue loan. | Overdue item is visibly marked as overdue. | Pass / Fail |
| 46 | RFID | Reader disconnected at startup | Start app with RFID reader disconnected. | App stays usable and shows appropriate offline/hardware status if configured. | Pass / Fail |
| 47 | RFID | Reader reconnect | Reconnect RFID reader while app is running. | RFID service recovers or app allows retry/reconnect without restart. | Pass / Fail |
| 48 | Error Handling | Backend unavailable | Stop backend/server, then try an operation. | User-friendly connection error appears; app does not crash. | Pass / Fail |
| 49 | Session | Auto return/home timeout | Leave a non-home screen idle until timeout. | App returns to Home according to configured timeout behavior. | Pass / Fail |
| 50 | Build | Installed app contains latest fix | Install latest setup exe and test unknown check-in item. | Installed build shows `Invalid item` once only, confirming latest code is packaged. | Pass / Fail |

