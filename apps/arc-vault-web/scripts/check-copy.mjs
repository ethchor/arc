/**
 * Copy check for the HIG writing rules (docs/18 §3.3). Short labels that the HIG writes in
 * title case (buttons, menu items and menu labels, dialog and card titles, tooltip titles
 * and sheet headings) must use title case. Full sentences, meaning text that ends in a
 * period or asks a question, keep sentence case.
 *
 * This is the package's `test` task, so CI runs it with every other test:
 *
 *   pnpm --filter @arc/vault-web test
 *
 * A failure prints the file, line and label. Fix the label; if it's a deliberate exception
 * (a brand written in lowercase, say), add it to ALLOWED below.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN = [join(ROOT, "src/components"), join(ROOT, "src/app")];

/** Elements whose text content is a title-case label. */
const TITLE_ELEMENTS = new Set([
  "Button",
  "CardTitle",
  "ContextMenuItem",
  "ContextMenuLabel",
  "ContextMenuSubTrigger",
  "DialogTitle",
  "DropdownMenuItem",
  "DropdownMenuLabel",
]);
/** Components whose `label` prop is a tooltip or control title. */
const LABEL_OWNERS = new Set(["CopyButton", "IconTip"]);
/** Words that stay lowercase inside a title (not first or last). */
const MINOR = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "nor", "of", "on",
  "or", "per", "the", "to", "via", "vs", "with",
]);
/** Lowercase on purpose: the product name and unit abbreviations ("5 min"). */
const LOWERCASE_WORDS = new Set(["arc", "min", "ms", "s", "h", "d"]);
/** Stands in for a `{expression}` in an element's text; a word that touches one is dynamic. */
const EXPR = "\u0000";
/** Deliberate exceptions, as `file:label`. */
const ALLOWED = new Set([]);
const MAX_WORDS = 8;

function isSentence(text) {
  return /[.?!]$/.test(text) || text.includes("?");
}

function isTitleCase(text) {
  const words = text
    .replace(/&amp;/g, "&")
    .replace(/[“”"'‘’()…:,·→]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words.every((word, i) =>
    word.split("-").every((part, j) => {
      if (!/^[a-z]/.test(part)) return true; // capitalized, a number or a symbol
      if (/[A-Z]/.test(part)) return true; // iPhone, macOS
      if (LOWERCASE_WORDS.has(part) || part.includes(EXPR)) return true;
      const inner = i > 0 && i < words.length - 1 && j === 0;
      return inner && MINOR.has(part);
    }),
  );
}

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (path.endsWith(".tsx")) out.push(path);
  }
  return out;
}

const failures = [];

for (const file of SCAN.flatMap((dir) => sourceFiles(dir))) {
  const rel = relative(ROOT, file);
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  const check = (node, raw, where) => {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!/[a-zA-Z]/.test(text.replaceAll(EXPR, "")) || isSentence(text)) return;
    if (text.split(" ").length > MAX_WORDS) return;
    if (isTitleCase(text) || ALLOWED.has(`${rel}:${text}`)) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    failures.push(`${rel}:${line + 1}  ${where}  "${text.replaceAll(EXPR, "{…}")}"`);
  };

  // Text inside plain HTML elements (<span>, <strong>) and fragments is part of the label;
  // components nested in it (<Badge>, icons) are not.
  const isTextContainer = (node) =>
    ts.isJsxFragment(node) || (ts.isJsxElement(node) && /^[a-z]/.test(node.openingElement.tagName.getText(sf)));

  // An element's text with each expression reduced to a placeholder; string branches of a
  // conditional (`{busy ? "Saving…" : "Save Changes"}`) are checked on their own.
  const textOf = (element, where) => {
    let text = "";
    for (const child of element.children) {
      if (ts.isJsxText(child)) text += child.getText();
      else if (isTextContainer(child)) text += textOf(child, where);
      else if (ts.isJsxExpression(child) && child.expression) {
        const expr = child.expression;
        if (ts.isStringLiteral(expr)) text += expr.text;
        else if (ts.isConditionalExpression(expr)) {
          for (const branch of [expr.whenTrue, expr.whenFalse]) {
            if (ts.isStringLiteral(branch)) check(branch, branch.text, where);
            else if (isTextContainer(branch)) check(branch, textOf(branch, where), where);
          }
        } else text += EXPR;
      }
    }
    return text;
  };

  const visit = (node) => {
    if (ts.isJsxElement(node)) {
      const name = node.openingElement.tagName.getText(sf);
      if (TITLE_ELEMENTS.has(name)) {
        check(node, textOf(node, name), name);
        return; // nested labels were checked as part of this one
      }
    }
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const prop = node.name.getText(sf);
      const owner = node.parent.parent.tagName?.getText(sf) ?? "";
      if (prop === "label" && LABEL_OWNERS.has(owner)) check(node, node.initializer.text, `${owner} label`);
      if (prop === "heading") check(node, node.initializer.text, "heading");
    }
    // tooltip={{ label, hint }}
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(sf) === "label" &&
      ts.isStringLiteral(node.initializer) &&
      node.parent.properties.some((p) => p.name?.getText(sf) === "hint")
    ) {
      check(node, node.initializer.text, "tooltip label");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

if (failures.length) {
  console.error(`Copy check: ${failures.length} label(s) should use title case (docs/18 §3.3):\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log("Copy check: all labels follow the HIG capitalization rules.");
