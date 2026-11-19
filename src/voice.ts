// Ditado no navegador (Web Speech API — no Chrome do Android usa o reconhecimento
// do Google, sem custo). O texto vai para o campo para revisar; nada é enviado.
// No app do PC não existe (WebKitGTK): lá o ditado é o /voice do Claude.

interface Alt { transcript: string }
interface Res { isFinal: boolean; 0: Alt }
interface RecEvent { resultIndex: number; results: { length: number; [i: number]: Res } }
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type Ctor = new () => Recognition;

const Impl = ((window as unknown as { SpeechRecognition?: Ctor }).SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: Ctor }).webkitSpeechRecognition) as Ctor | undefined;

export const dictationSupported = () => !!Impl && window.isSecureContext;

const ERRORS: Record<string, string> = {
  "not-allowed": "Microfone bloqueado — permita o acesso ao microfone para este site",
  "service-not-allowed": "Ditado indisponível neste navegador",
  "audio-capture": "Nenhum microfone encontrado",
  network: "Ditado precisa de internet",
};

/**
 * Liga/desliga o ditado num campo. O que já estava escrito fica; o falado entra
 * depois (parcial enquanto fala, firme quando o reconhecedor confirma).
 */
export class Dictation {
  private rec: Recognition | null = null;

  constructor(
    private field: HTMLTextAreaElement,
    private onChange: (listening: boolean) => void,
    private onError: (msg: string) => void,
  ) {}

  get listening() {
    return !!this.rec;
  }

  toggle() {
    if (this.rec) this.stop();
    else this.start();
  }

  stop() {
    this.rec?.stop(); // o onend fecha o estado (e entrega o último trecho)
  }

  /** Encerra já, descartando o que ainda não chegou (o campo fica como está). */
  cancel() {
    const rec = this.rec;
    if (!rec) return;
    this.rec = null;
    rec.abort();
    this.onChange(false);
  }

  private start() {
    if (!Impl) return;
    const rec = new Impl();
    rec.lang = "pt-BR";
    rec.continuous = true;
    rec.interimResults = true;
    const before = this.field.value.replace(/\s+$/, "");
    const base = before ? `${before} ` : "";
    rec.onresult = (e) => {
      if (this.rec !== rec) return; // cancelado (ex.: a mensagem já foi enviada)
      // Remonta a partir de todos os resultados (a lista da sessão é completa).
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      this.field.value = base + text.replace(/^\s+/, "");
      this.field.dispatchEvent(new Event("input")); // ajusta a altura do campo
    };
    rec.onerror = (e) => {
      if (e.error !== "no-speech" && e.error !== "aborted") this.onError(ERRORS[e.error] ?? `Ditado: ${e.error}`);
    };
    rec.onend = () => {
      if (this.rec !== rec) return;
      this.rec = null;
      this.onChange(false);
    };
    try {
      rec.start();
    } catch (e) {
      this.onError(`Ditado: ${e}`);
      return;
    }
    this.rec = rec;
    this.onChange(true);
  }
}
