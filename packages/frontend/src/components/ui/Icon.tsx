import type { CSSProperties } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  ChevronsUpDown,
  PanelLeftClose,
  PanelLeftOpen,
  X,
  Plus,
  Ellipsis,
  EllipsisVertical,
  Check,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  ExternalLink,
  Pin,
  Columns2,
  Rows2,
  Merge,
  ArrowRightToLine,
  SquareX,
  Settings,
  LayoutGrid,
  ListTodo,
  Folder,
  GitBranch,
  Database,
  Bell,
  Search,
  Play,
  Square,
  Pencil,
  Trash2,
  RotateCw,
  Terminal,
  Server,
  Folders,
  TriangleAlert,
  Cpu,
  Globe,
  Palette,
  List,
  Kanban,
  PictureInPicture2,
  Camera,
  Image,
  Keyboard,
  CircleHelp,
  Eye,
  File,
  FileCode,
  FolderOpen,
  Upload,
  Download,
  Copy,
  Link,
  Activity,
  GitCommitHorizontal,
  type LucideIcon,
} from 'lucide-react';
import { SidekickBot, UnitsSquad } from './custom-icons';

// UI 機能アイコンの唯一の入口（設計方針: docs/ja/ui-surface-policy.md）。
// lucide-react を直接 import してよいのはこのファイルだけ。
// ピクセルアイコン（PixelIcon）はロゴ・空状態などブランドモーメント専用。
const ICONS = {
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  'chevron-left': ChevronLeft,
  'chevrons-up-down': ChevronsUpDown,
  'panel-left-close': PanelLeftClose,
  'panel-left-open': PanelLeftOpen,
  close: X,
  plus: Plus,
  more: Ellipsis,
  'more-vertical': EllipsisVertical,
  check: Check,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  'arrow-up': ArrowUp,
  'arrow-down': ArrowDown,
  'external-link': ExternalLink,
  pin: Pin,
  'split-h': Columns2,
  'split-v': Rows2,
  merge: Merge,
  'pane-next': ArrowRightToLine,
  'pane-close': SquareX,
  settings: Settings,
  windows: LayoutGrid,
  tasks: ListTodo,
  files: Folder,
  repos: GitBranch,
  storage: Database,
  bell: Bell,
  search: Search,
  play: Play,
  stop: Square,
  edit: Pencil,
  trash: Trash2,
  refresh: RotateCw,
  terminal: Terminal,
  servers: Server,
  projects: Folders,
  warning: TriangleAlert,
  chip: Cpu,
  browser: Globe,
  palette: Palette,
  list: List,
  kanban: Kanban,
  pip: PictureInPicture2,
  camera: Camera,
  image: Image,
  keyboard: Keyboard,
  question: CircleHelp,
  watch: Eye,
  file: File,
  'file-code': FileCode,
  'folder-open': FolderOpen,
  upload: Upload,
  download: Download,
  copy: Copy,
  link: Link,
  units: UnitsSquad,
  operations: Activity,
  sidekicks: SidekickBot,
  'git-commit': GitCommitHorizontal,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

interface IconProps {
  name: IconName;
  /** 表示サイズ(px)。最小16を基本とし、タブ内クローズ等のみ14を許可 */
  size?: 14 | 16 | 20 | 24;
  /** 開閉表現用の回転（chevron 系のみで使用）。reduced-motion では即時反映 */
  rotate?: number;
  style?: CSSProperties;
}

// サイズ別ストローク: 小サイズほど太くして視覚等価を保つ
const STROKE: Record<NonNullable<IconProps['size']>, number> = {
  14: 1.75,
  16: 1.6,
  20: 1.5,
  24: 1.4,
};

export function Icon({ name, size = 16, rotate, style }: IconProps) {
  const C = ICONS[name];
  return (
    <C
      size={size}
      strokeWidth={STROKE[size]}
      aria-hidden="true"
      style={{
        flexShrink: 0,
        ...(rotate !== undefined
          ? { transform: `rotate(${rotate}deg)`, transition: 'transform 130ms ease' }
          : undefined),
        ...style,
      }}
    />
  );
}
