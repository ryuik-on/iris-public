/**
 * 会話の出し先を選ぶ小窓。
 *
 * 入力バーの chip には長らく「**読むだけで、押せない。ここから選ばせる口は
 * 無い**」と書いてあった。無い口を押せるように見せるのは避ける、という判断で
 * 正しかった。**口ができたので、押せるようにする。**
 *
 * ## 順番ではなく、先頭だけを選ばせる
 *
 * 並べ替えの画面にすると、無料枠を末尾から外せてしまう。router がいちばん
 * 嫌う失敗は「枠が尽きて会話が文の途中で死ぬ」ことで、**その道を利用者が
 * 自分で作れる画面にはしない。**選ぶのは先頭だけ、控えは常に後ろに付く。
 *
 * ## 「既定」を明示的に残す
 *
 * 選んでいない状態と、選んだ結果それが先頭になっている状態は別のこと。
 * 前者は環境変数が変われば動くが、後者は動かない。**同じ見た目にしない。**
 */
interface LaneState {
  chosen: string | null;
  serving: string | null;
  options: Array<{ id: string; model: string }>;
}

const LANES: Array<{ key: 'voice' | 'text'; label: string; hint: string }> = [
  { key: 'voice', label: '声で返すとき', hint: '待たされた分がそのまま沈黙になる' },
  { key: 'text', label: '文字で返すとき', hint: '一秒の差より判断の確かさ' },
];

export function LanePicker({
  lanes,
  onPick,
  onClose,
}: {
  lanes: { voice: LaneState; text: LaneState };
  onPick: (lane: 'voice' | 'text', provider: string | null) => void;
  onClose: () => void;
}) {
  return (
    <>
      {/* 外を押したら閉じる。小窓の中の押下は下の層に届かない。 */}
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      <div
        className="absolute bottom-full right-0 mb-2 z-50 w-[264px] rounded-xl border p-3 space-y-3
                   shadow-xl shadow-black/20 backdrop-blur-md"
        style={{
          // 明暗どちらでも成り立つよう、色は token から取る。**直書きすると
          // 片方の地の上で読めなくなる** —— 実測 2026-09-11、明るい配色の
          // 画面に暗い小窓が出た。
          background: 'var(--hud-panel)',
          borderColor: 'var(--hud-line)',
          color: 'var(--hud-text)',
        }}
        role="dialog"
        aria-label="会話の出し先"
      >
        {LANES.map(({ key, label, hint }) => {
          const lane = lanes[key];
          if (!lane) return null;
          return (
            <div key={key}>
              <div className="flex items-baseline justify-between gap-2 mb-1.5">
                <span className="text-[11px] font-medium" style={{ color: 'var(--hud-text)' }}>{label}</span>
                <span className="text-[10px] truncate" style={{ color: 'var(--hud-muted)' }}>{hint}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                <Choice
                  label="既定"
                  active={lane.chosen === null}
                  onClick={() => onPick(key, null)}
                />
                {lane.options.map((o) => (
                  <Choice
                    key={o.id}
                    label={o.model}
                    active={lane.chosen === o.id}
                    onClick={() => onPick(key, o.id)}
                  />
                ))}
              </div>
              {/*
                いま実際に先頭に立っている相手。選んだものと違うことがある
                —— 枠切れや予算超過で router が飛ばした場合。**選んだ通りに
                なっていると決めつけない。**
              */}
              {lane.serving && (
                <p className="mt-1 text-[10px]" style={{ color: 'var(--hud-muted)' }}>いま {lane.serving}</p>
              )}
            </div>
          );
        })}
        <p
          className="text-[10px] leading-relaxed border-t pt-2"
          style={{ color: 'var(--hud-muted)', borderColor: 'var(--hud-line)' }}
        >
          控えは常に後ろに付きます。選んだ相手が使えない日も、会話は続きます。
        </p>
      </div>
    </>
  );
}

function Choice({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'px-2 py-1 rounded-md text-[10px] transition border ' +
        (active ? '' : 'hover:opacity-100 opacity-70')
      }
      style={
        active
          ? {
              background: 'color-mix(in srgb, var(--hud-accent) 18%, transparent)',
              borderColor: 'color-mix(in srgb, var(--hud-accent) 45%, transparent)',
              color: 'var(--hud-accent)',
            }
          : {
              background: 'color-mix(in srgb, var(--hud-text) 4%, transparent)',
              borderColor: 'var(--hud-line)',
              color: 'var(--hud-muted)',
            }
      }
    >
      {label}
    </button>
  );
}
