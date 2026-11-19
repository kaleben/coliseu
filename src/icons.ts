// Ícones Lucide como strings SVG (para usar dentro dos templates HTML).
import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Bell,
  CaseSensitive,
  Check,
  CodeXml,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  Copy,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  GitPullRequestDraft,
  MessageSquare,
  Mic,
  UserCheck,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Gauge,
  Hand,
  FileText,
  Shield,
  Columns2,
  Ellipsis,
  FolderOpen,
  Keyboard,
  LoaderCircle,
  Palette,
  PanelLeft,
  Pencil,
  Plus,
  RefreshCw,
  Regex,
  Rows2,
  Search,
  Settings,
  Smartphone,
  Menu,
  SquareTerminal,
  Trash2,
  UserRound,
  X,
  createElement,
} from "lucide";

const ICONS = {
  arrowDown: ArrowDown,
  arrowUp: ArrowUp,
  bell: Bell,
  caseSensitive: CaseSensitive,
  check: Check,
  code: CodeXml,
  circleCheck: CircleCheck,
  circleDashed: CircleDashed,
  circleX: CircleX,
  clock: Clock,
  copy: Copy,
  external: ExternalLink,
  branch: GitBranch,
  pr: GitPullRequest,
  prDraft: GitPullRequestDraft,
  message: MessageSquare,
  mic: Mic,
  userCheck: UserCheck,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  chevronLeft: ChevronLeft,
  gauge: Gauge,
  hand: Hand,
  file: FileText,
  shield: Shield,
  folder: FolderOpen,
  keyboard: Keyboard,
  loader: LoaderCircle,
  more: Ellipsis,
  palette: Palette,
  panel: PanelLeft,
  pencil: Pencil,
  plus: Plus,
  refresh: RefreshCw,
  regex: Regex,
  search: Search,
  settings: Settings,
  phone: Smartphone,
  menu: Menu,
  splitDown: Rows2,
  splitRight: Columns2,
  swap: ArrowLeftRight,
  terminal: SquareTerminal,
  trash: Trash2,
  user: UserRound,
  x: X,
} as const;

export type IconName = keyof typeof ICONS;

const cache = new Map<string, string>();

/** SVG do ícone como string. `size` em px. */
export function icon(name: IconName, size = 15, cls = ""): string {
  const key = `${name}:${size}:${cls}`;
  let svg = cache.get(key);
  if (!svg) {
    const el = createElement(ICONS[name], {
      width: size,
      height: size,
      "stroke-width": 1.75,
      class: `i ${cls}`.trim(),
      "aria-hidden": "true",
    });
    svg = el.outerHTML;
    cache.set(key, svg);
  }
  return svg;
}

/** Símbolo estilizado do Claude (estrela de raios). */
export function claudeMark(size = 14): string {
  const rays = Array.from({ length: 12 }, (_, i) => {
    const a = (i * Math.PI) / 6;
    const long = i % 2 === 0 ? 10.5 : 8.2;
    const x = 12 + Math.cos(a) * long;
    const y = 12 + Math.sin(a) * long;
    return `<line x1="12" y1="12" x2="${x.toFixed(2)}" y2="${y.toFixed(2)}"/>`;
  }).join("");
  return `<svg class="i mark-claude" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><g stroke="currentColor" stroke-width="2.6" stroke-linecap="round">${rays}</g></svg>`;
}
