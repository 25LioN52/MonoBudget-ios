"use strict";
// Strict fakes of the Scriptable APIs used by MonoBudget.js. Accessing or setting
// a property that the real API does not have throws, which catches typos in the
// Scriptable-only code that unit tests of the pure core cannot reach.

function strict(name, target, allowed) {
  const props = new Set(allowed);
  return new Proxy(target, {
    get(obj, key) {
      if (typeof key === "symbol" || key === "then" || key === "toJSON" || key in obj) return obj[key];
      throw new TypeError(`${name}.${String(key)} is not part of the Scriptable API`);
    },
    set(obj, key, value) {
      if (!props.has(key)) throw new TypeError(`${name}.${String(key)} cannot be set in the Scriptable API`);
      obj[key] = value;
      return true;
    },
  });
}

class Size { constructor(width, height) { Object.assign(this, { width, height }); } }
class Point { constructor(x, y) { Object.assign(this, { x, y }); } }
class Rect { constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); } }
class Color {
  constructor(hex, alpha) {
    if (!/^#?[0-9a-f]{6}$/i.test(hex)) throw new TypeError(`bad color ${hex}`);
    this.hex = hex;
    this.alpha = alpha === undefined ? 1 : alpha;
  }
  static dynamic(light, dark) {
    if (!(light instanceof Color) || !(dark instanceof Color)) throw new TypeError("Color.dynamic needs two colors");
    return light;
  }
}

const FONT_NAMES = ["systemFont", "ultraLightSystemFont", "thinSystemFont", "lightSystemFont", "regularSystemFont",
  "mediumSystemFont", "semiboldSystemFont", "boldSystemFont", "heavySystemFont", "blackSystemFont", "italicSystemFont",
  "regularRoundedSystemFont", "mediumRoundedSystemFont", "semiboldRoundedSystemFont", "boldRoundedSystemFont",
  "heavyRoundedSystemFont", "blackRoundedSystemFont", "regularMonospacedSystemFont"];
const Font = {};
for (const name of FONT_NAMES) {
  Font[name] = (size) => {
    if (typeof size !== "number") throw new TypeError(`Font.${name} needs a size`);
    return { font: name, size };
  };
}

class Image {}

function makePath() {
  const ops = [];
  return strict("Path", {
    ops,
    move: (p) => ops.push(p), addLine: (p) => ops.push(p), addRect: (r) => ops.push(r), addEllipse: (r) => ops.push(r),
    addRoundedRect: (rect, w, h) => {
      if (!(rect instanceof Rect) || typeof w !== "number" || typeof h !== "number") throw new TypeError("addRoundedRect");
      ops.push(rect);
    },
    addLines: (points) => {
      if (!points.every((p) => p instanceof Point)) throw new TypeError("addLines needs Points");
      ops.push(...points);
    },
    addRects: (rects) => ops.push(...rects), closeSubpath: () => {},
  }, []);
}
function Path() { return makePath(); }

function DrawContext() {
  return strict("DrawContext", {
    size: null, opaque: true, respectScreenScale: false,
    setFillColor: (c) => { if (!(c instanceof Color)) throw new TypeError("setFillColor"); },
    setStrokeColor: (c) => { if (!(c instanceof Color)) throw new TypeError("setStrokeColor"); },
    setLineWidth: (w) => { if (typeof w !== "number") throw new TypeError("setLineWidth"); },
    fillRect: (r) => { if (!(r instanceof Rect)) throw new TypeError("fillRect"); },
    fillEllipse: () => {}, strokeRect: () => {},
    strokeEllipse: (r) => { if (!(r instanceof Rect)) throw new TypeError("strokeEllipse"); },
    addPath: () => {}, fillPath: () => {}, strokePath: () => {},
    getImage() {
      if (!(this.size instanceof Size)) throw new TypeError("DrawContext.size must be a Size");
      return new Image();
    },
  }, ["size", "opaque", "respectScreenScale"]);
}

function widgetText(text) {
  if (typeof text !== "string") throw new TypeError("addText needs a string");
  return strict("WidgetText", {
    text, font: null, textColor: null, lineLimit: 0, minimumScaleFactor: 1, textOpacity: 1, url: null,
    leftAlignText() {}, centerAlignText() {}, rightAlignText() {},
  }, ["text", "font", "textColor", "lineLimit", "minimumScaleFactor", "textOpacity", "url"]);
}
function widgetImage(image) {
  if (!(image instanceof Image)) throw new TypeError("addImage needs an Image");
  return strict("WidgetImage", {
    image, imageSize: null, resizable: true, tintColor: null, url: null, imageOpacity: 1, cornerRadius: 0,
    leftAlignImage() {}, centerAlignImage() {}, rightAlignImage() {},
  }, ["image", "imageSize", "resizable", "tintColor", "url", "imageOpacity", "cornerRadius"]);
}
function container(name, extra, settable) {
  const children = [];
  const base = {
    children,
    backgroundColor: null, backgroundImage: null, spacing: 0, url: null,
    addText(text) { const t = widgetText(text); children.push(t); return t; },
    addImage(image) { const i = widgetImage(image); children.push(i); return i; },
    addSpacer(length) { if (length !== undefined && typeof length !== "number") throw new TypeError("addSpacer"); children.push({ spacer: length }); },
    addStack() { const s = widgetStack(); children.push(s); return s; },
    setPadding(...values) { if (values.length !== 4) throw new TypeError("setPadding needs 4 values"); },
    useDefaultPadding() {},
    ...extra,
  };
  return strict(name, base, ["backgroundColor", "backgroundImage", "spacing", "url", ...settable]);
}
function widgetStack() {
  return container("WidgetStack", {
    size: null, cornerRadius: 0,
    layoutHorizontally() {}, layoutVertically() {}, topAlignContent() {}, centerAlignContent() {}, bottomAlignContent() {},
  }, ["size", "cornerRadius"]);
}
function ListWidget() {
  return container("ListWidget", {
    refreshAfterDate: null, addAccessoryWidgetBackground: false,
    presentSmall: async () => {}, presentMedium: async () => {}, presentLarge: async () => {},
  }, ["refreshAfterDate", "addAccessoryWidgetBackground"]);
}

function tableCell(title) {
  return strict("UITableCell", {
    title, widthWeight: 1, titleColor: null, subtitleColor: null, titleFont: null, subtitleFont: null, onTap: null, dismissOnTap: true,
    leftAligned() {}, centerAligned() {}, rightAligned() {},
  }, ["widthWeight", "titleColor", "subtitleColor", "titleFont", "subtitleFont", "onTap", "dismissOnTap"]);
}
function UITableRow() {
  const cells = [];
  return strict("UITableRow", {
    cells, height: 44, isHeader: false, dismissOnSelect: true, onSelect: null, backgroundColor: null, cellSpacing: 0,
    addText(title, subtitle) {
      if (typeof title !== "string" || (subtitle != null && typeof subtitle !== "string")) throw new TypeError("addText");
      const c = tableCell(title); cells.push(c); return c;
    },
    addButton(title) { const c = tableCell(title); cells.push(c); return c; },
    addImage(image) { if (!(image instanceof Image)) throw new TypeError("addImage"); const c = tableCell(); cells.push(c); return c; },
  }, ["height", "isHeader", "dismissOnSelect", "onSelect", "backgroundColor", "cellSpacing"]);
}

function createEnvironment({ widgetFamily, widgetParameter, queryParameters, token, responses, dismissAfterMs }) {
  const files = new Map();
  const keychain = new Map(token ? [["monobudget.monobank-token", token]] : []);
  const requests = [];
  const tables = [];
  const alerts = [];
  let widget = null;
  let completed = false;

  class Request {
    constructor(url) {
      this.url = url;
      this.method = "GET";
      this.headers = {};
      this.timeoutInterval = 60;
      this.response = null;
      this.onRedirect = null;
      return strict("Request", this, ["url", "method", "headers", "timeoutInterval", "response", "body", "onRedirect"]);
    }
    async loadString() {
      requests.push({ url: this.url, headers: { ...this.headers }, onRedirect: this.onRedirect });
      const path = this.url.replace("https://api.monobank.ua", "");
      const route = Object.keys(responses).find((prefix) => path.startsWith(prefix));
      const [status, body] = route ? responses[route](path) : [404, "{}"];
      this.response = { statusCode: status };
      return body;
    }
  }

  class UITable {
    constructor() {
      this.rows = [];
      this.showSeparators = false;
      tables.push(this);
      return strict("UITable", this, ["showSeparators"]);
    }
    addRow(row) { this.rows.push(row); }
    removeAllRows() { this.rows.length = 0; }
    reload() {}
    present(fullscreen) {
      if (typeof fullscreen !== "boolean") throw new TypeError("present(fullscreen)");
      return new Promise((resolve) => setTimeout(resolve, dismissAfterMs || 30));
    }
  }

  class Alert {
    constructor() {
      this.title = ""; this.message = ""; this.fields = []; this.actions = [];
      alerts.push(this);
      return strict("Alert", this, ["title", "message"]);
    }
    addAction(t) { this.actions.push(t); }
    addDestructiveAction(t) { this.actions.push(t); }
    addCancelAction() {}
    addSecureTextField(placeholder, text) { this.fields.push(text || ""); }
    textFieldValue() { return token || ""; }
    async presentAlert() { return 0; }
  }

  const fm = strict("FileManager", {
    libraryDirectory: () => "/lib",
    joinPath: (a, b) => `${a}/${b}`,
    fileExists: (p) => files.has(p) || [...files.keys()].some((k) => k.startsWith(p + "/")),
    createDirectory: () => {},
    readString: (p) => files.get(p),
    writeString: (p, s) => { if (typeof s !== "string") throw new TypeError("writeString"); files.set(p, s); },
    remove: (p) => files.delete(p),
  }, []);

  const globals = {
    Size, Point, Rect, Color, Font, Path, DrawContext, ListWidget, UITable, UITableRow, Alert, Request,
    FileManager: { local: () => fm, iCloud: () => { throw new Error("iCloud must not be used"); } },
    Keychain: {
      contains: (k) => keychain.has(k), get: (k) => keychain.get(k),
      set: (k, v) => keychain.set(k, v), remove: (k) => keychain.delete(k),
    },
    Timer: { schedule: (ms, repeats, cb) => setTimeout(cb, Math.min(ms, 5)) },
    Script: { name: () => "Mono Budget", setWidget: (w) => { widget = w; }, complete: () => { completed = true; } },
    Device: { language: () => "uk" },
    config: { runsInWidget: Boolean(widgetFamily), widgetFamily, runsInApp: !widgetFamily },
    args: { widgetParameter: widgetParameter || null, queryParameters: queryParameters || {} },
  };

  return {
    globals, files, keychain, requests, tables, alerts,
    get widget() { return widget; },
    get completed() { return completed; },
  };
}

module.exports = { createEnvironment };
