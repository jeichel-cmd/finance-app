# Finance

A private money tracker for your phone. Add screenshots from your banking apps, PayPal, brokers and crypto exchanges; the app reads balances and transactions on the phone, sorts spending into categories and tells you when a screenshot doesn't match what's in the app.

- **Nothing leaves the phone.** Screenshots are read on the device with Tesseract (WebAssembly), shipped in `vendor/`. The page's Content Security Policy blocks connections to any other server.
- **Encrypted.** All data is stored in the browser's IndexedDB, encrypted with AES-GCM using a key derived from your passcode (PBKDF2, 600,000 rounds). Backups are encrypted the same way.
- **Works offline** once installed to the home screen.
- **PayPal paid from your bank is counted once:** the payment counts as spending in PayPal (with the shop's name) without changing the PayPal balance, and the bank's PayPal debit counts as a transfer between your own accounts.

## Install on your phone

The app is a static web app. Once it's hosted (GitHub Pages, see below), open the link on your phone:

- **iPhone:** Safari, Share, Add to Home Screen.
- **Android:** Chrome, menu, Install app (or Add to Home screen).

## Hosting on GitHub Pages (free)

Repository Settings, Pages, Source: "Deploy from a branch", branch `main`, folder `/ (root)`.

## Development

```sh
npm install
npm test          # unit tests (parsing, categories, balances, encryption)
npm run e2e       # phone-sized browser test with real screenshots read on-device
npm run vendor    # refresh the bundled text reader from node_modules
npm run icons     # re-render PNG icons from icons/icon.svg
```

No build step: the files in the repository are what the phone loads.
