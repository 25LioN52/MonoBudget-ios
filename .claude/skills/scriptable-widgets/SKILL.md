---
name: scriptable-widgets
description: Reference for writing or changing Scriptable (iOS) code in MonoBudget.js — widget families, ListWidget/WidgetStack layout, DrawContext drawing, UITable reports, Keychain, FileManager, Request, URL scheme and runtime gotchas. Use before touching the SCRIPTABLE section or tests/scriptable-mock.js.
---

# Scriptable reference for MonoBudget

Official docs: https://docs.scriptable.app/ — the strict mock in `tests/scriptable-mock.js` must mirror the real API. Add any new API member there exactly as documented, or the smoke tests will (correctly) fail.

## Runtime

- Scripts run in JavaScriptCore inside an async wrapper: top-level `await` works. Call `Script.complete()` at the end.
- Contexts: `config.runsInWidget`, `config.widgetFamily` (`small`, `medium`, `large`, `extraLarge`, `accessoryRectangular`, `accessoryCircular`, `accessoryInline`), `config.runsInApp`.
- Inputs: `args.widgetParameter` (the widget's Parameter field), `args.queryParameters` (from `scriptable:///run?scriptName=…&key=value`).
- Widgets get only a few seconds and limited memory: **at most one Monobank request per widget run**; render from cache.
- iOS decides refresh timing; `widget.refreshAfterDate` is only a hint.

## Widgets

- `ListWidget`: `addText`, `addStack`, `addImage`, `addSpacer(len?)`, `setPadding(t,l,b,r)`, `backgroundColor`, `backgroundImage`, `url`, `refreshAfterDate`, `addAccessoryWidgetBackground` (bool, accessory widgets).
- `WidgetStack`: same adders + `layoutVertically()`, `layoutHorizontally()`, `top/center/bottomAlignContent()`, `size`, `url`. No z-stack: use `backgroundImage` for layering (e.g. the circular ring).
- `WidgetText`: `font`, `textColor`, `lineLimit`, `minimumScaleFactor`, `left/center/rightAlignText()`.
- `WidgetImage`: `imageSize`, `resizable`, `tintColor`.
- Tap targets: `stack.url` works only in medium/large widgets; small and accessory widgets have a single target (`widget.url`). A set URL overrides the widget's "When Interacting" setting.
- Accessory (lock screen) widgets are rendered tinted/monochrome by iOS — draw with white + alpha.
- Dark mode: `Color.dynamic(light, dark)` for widget elements. `DrawContext` images are static bitmaps, so use colors that work on both backgrounds (see `PALETTE`).

## Drawing

- `DrawContext`: set `size` (a `Size`), `opaque = false`, `respectScreenScale = true`; `setFillColor`, `setStrokeColor`, `setLineWidth`, `fillRect`, `strokeEllipse`, `addPath` + `fillPath`/`strokePath`, `getImage()`.
- `Path`: `addRoundedRect(rect, cw, ch)`, `addLines(points)`, `move`, `addLine`. There is **no arc API** — approximate arcs with `addLines` (see `drawRing`).
- Draw at 2× the displayed size and set `imageSize` to the display size.

## In-app UI

- `UITable` (`addRow`, `removeAllRows`, `reload`, `present(fullscreen)` → Promise resolved on dismiss, `showSeparators`).
- `UITableRow` (`addText(title, subtitle)`, `addButton`, `addImage`, `height`, `isHeader`, `onSelect`, `dismissOnSelect`).
- `UITableCell` (`widthWeight`, `titleFont`, `titleColor`, `subtitleColor`, `left/center/rightAligned()`, `onTap`, `dismissOnTap`).
- Re-render pattern: mutate UI state → `removeAllRows()` → add rows → `reload()`. Background work can continue while the table is presented.
- `Alert`: `addSecureTextField` for the token, `presentAlert()` → index (−1 = cancel).

## Storage, secrets, network

- Token: `Keychain.get/set/contains/remove`. Keychain is shared by all Scriptable scripts — never widen exposure (no copying to files, clipboard or logs).
- Cache: `FileManager.local()` + `libraryDirectory()` (private, not in Files or iCloud Drive; included in device backups). Never `FileManager.iCloud()` or `documentsDirectory()` for financial data. `cacheDirectory()` is avoided because it may not be shared between the app and the widget extension.
- The app and each widget run in **separate processes** sharing the cache file: always go through `syncWithStore` (reload → claim rate-limit slot on disk → request → reload → generation check → apply → save). `store.save` refuses to overwrite a newer generation; an unreadable cache is never overwritten by a widget.
- `Request`: set `method`, `headers`, `timeoutInterval`, and `onRedirect = () => null` (a followed redirect would carry `X-Token` to another host); `await loadString()`; status in `request.response.statusCode`. Never log the request (headers hold the token). Never set `allowInsecureRequest`.
- Never write invisible/bidi characters literally — use `\u` escapes built so they stay escapes (the scanner's `hidden-unicode` rule and `tests/misc.test.js` enforce this).
- Sleep: `Timer.schedule(ms, false, callback)`.
