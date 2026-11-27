import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

const cssVar = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

export function defineTheme() {
  monaco.editor.defineTheme("coliseu", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": cssVar("--bg", "#09090b"),
      "editorGutter.background": cssVar("--bg", "#09090b"),
      "editor.lineHighlightBackground": cssVar("--surface-2", "#141417"),
      "editorLineNumber.foreground": cssVar("--muted", "#6e6e78"),
      "editorWidget.background": cssVar("--surface", "#0c0c0e"),
      "editorWidget.border": cssVar("--border-strong", "#2a2a31"),
      focusBorder: cssVar("--accent", "#8b5cf6"),
    },
  });
}

monaco.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
monaco.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });

export { monaco };
