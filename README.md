# LabelPress — Direct Barcode Print

Standalone desktop web app that prints **Code 128** barcodes **directly** to a Zebra, TSC, or other installed label printer — no JSPrintManager client, no on-screen preview, and no browser print dialog.

## How it works

1. You type a string and click **Print Barcode**.
2. The app builds raw **ZPL** (Zebra), **TSPL** (TSC), or **EPL** (older Zebra GC) commands.
3. A local Node print API sends those commands to the OS printer queue:
   - Linux / macOS: CUPS (`lp -o raw`)
   - Windows: spooler RAW (`winspool.drv`)
4. The physical printer prints immediately.

## Requirements

- Node.js 18+
- A Zebra / TSC / compatible printer **already installed** on this PC

## Setup

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

Production:

```bash
npm run build
npm start
```

`npm start` serves the built UI and the local print API together.

## Scripts

| Command           | Description                          |
| ----------------- | ------------------------------------ |
| `npm run dev`     | Vite + local print API               |
| `npm run build`   | Typecheck + production build         |
| `npm run preview` | Preview production build + print API |
| `npm start`       | Serve `dist` + print API             |

## Usage

1. Enter barcode text.
2. Pick the installed printer (or Default).
3. Confirm **ZPL**, **TSPL**, or **EPL** (auto-guessed from the printer name).
4. Click **Print Barcode** (or press Enter).

## Stack

- React 19 + TypeScript + Vite
- Local OS print bridge (no third-party print client)


-- the code is working withouth jsp manager client