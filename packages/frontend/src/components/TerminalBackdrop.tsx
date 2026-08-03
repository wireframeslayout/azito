import { useTerminalTheme, type BackdropRenderInfo } from '../hooks/useTerminalTheme';

interface TerminalBackdropProps {
  variant: 'terminal' | 'app';
}

function BackdropLayers({ backdrop }: { backdrop: BackdropRenderInfo }) {
  return (
    <>
      <div style={{ position: 'absolute', inset: 0, background: backdrop.baseCss }} />
      {backdrop.imageUrl && (
        <div
          style={{
            position: 'absolute',
            inset: backdrop.imageBlur ? -12 : 0,
            backgroundImage: `url(${backdrop.imageUrl})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            opacity: backdrop.imageOpacity,
            filter: backdrop.imageBlur ? `blur(${backdrop.blurIntensity * 12}px)` : undefined,
            transform: backdrop.imageBlur ? 'scale(1.06)' : undefined,
          }}
        />
      )}
      {backdrop.overlayCss && (
        <div style={{ position: 'absolute', inset: 0, background: backdrop.overlayCss }} />
      )}
    </>
  );
}

export default function TerminalBackdrop({ variant }: TerminalBackdropProps) {
  const { backdrop } = useTerminalTheme();

  if (variant === 'app') {
    // Workspaceスコープではmode:'none'でもテーマ背景色(baseCss)を全面に塗る
    if (backdrop.scope !== 'app') return null;
    // .workspace-panel（isolation: isolate）内の最背面に置く。負のz-indexで
    // パネル自身の背景より前・全コンテンツより後ろにペイントされる
    return (
      <div style={{ position: 'absolute', inset: 0, zIndex: -1, pointerEvents: 'none', overflow: 'hidden' }}>
        <BackdropLayers backdrop={backdrop} />
      </div>
    );
  }

  if (backdrop.scope === 'app' || backdrop.mode === 'none') return null;

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none', overflow: 'hidden' }}>
      <BackdropLayers backdrop={backdrop} />
    </div>
  );
}
