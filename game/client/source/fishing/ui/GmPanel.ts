import type { GmController, GmPhase } from '../systems/GmController'

const PHASES: { id: GmPhase; label: string; hint: string }[] = [
  { id: 'sailing', label: '① 航行 · 底牌甩钩', hint: '破浪节奏 + 甩钩窗口' },
  { id: 'lure', label: '② 诱鱼 · 左右滑键', hint: 'LurePads 双滑引诱' },
  { id: 'battle', label: '③ 战斗 · 3D 追鱼', hint: '张力条 + 透视追逐' },
]

/**
 * Floating HTML panel for dev phase jumps. Toggle with ` (backtick).
 */
export class GmPanel {
  private readonly root: HTMLDivElement
  private readonly statusEl: HTMLSpanElement
  private visible = false

  constructor(private readonly controller: GmController) {
    this.root = document.createElement('div')
    this.root.id = 'fishing-gm-panel'
    this.root.innerHTML = `
      <style>
        #fishing-gm-panel {
          position: absolute;
          top: 12px;
          right: 12px;
          z-index: 10000;
          width: min(280px, calc(100vw - 24px));
          font-family: Menlo, Consolas, monospace;
          font-size: 12px;
          color: #e8f4ff;
          background: rgba(8, 18, 32, 0.92);
          border: 1px solid rgba(120, 200, 255, 0.35);
          border-radius: 10px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
          pointer-events: auto;
          user-select: none;
          display: none;
        }
        #fishing-gm-panel.open { display: block; }
        #fishing-gm-panel .gm-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 12px 8px;
          border-bottom: 1px solid rgba(120, 200, 255, 0.2);
        }
        #fishing-gm-panel .gm-title {
          font-weight: 700;
          letter-spacing: 0.04em;
          color: #7ec8ff;
        }
        #fishing-gm-panel .gm-hint-key {
          opacity: 0.55;
          font-size: 10px;
        }
        #fishing-gm-panel .gm-status {
          display: block;
          padding: 6px 12px 8px;
          font-size: 10px;
          opacity: 0.7;
          border-bottom: 1px solid rgba(120, 200, 255, 0.12);
        }
        #fishing-gm-panel .gm-actions {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 10px 12px 12px;
        }
        #fishing-gm-panel button {
          all: unset;
          cursor: pointer;
          padding: 8px 10px;
          border-radius: 6px;
          background: rgba(40, 90, 140, 0.55);
          border: 1px solid rgba(120, 200, 255, 0.25);
          transition: background 0.15s, border-color 0.15s;
        }
        #fishing-gm-panel button:hover {
          background: rgba(60, 120, 180, 0.75);
          border-color: rgba(160, 220, 255, 0.5);
        }
        #fishing-gm-panel button:active { transform: scale(0.98); }
        #fishing-gm-panel .gm-btn-label { font-weight: 600; display: block; }
        #fishing-gm-panel .gm-btn-hint {
          display: block;
          margin-top: 2px;
          font-size: 10px;
          opacity: 0.65;
        }
      </style>
      <div class="gm-head">
        <span class="gm-title">GM 测试</span>
        <span class="gm-hint-key">\` 切换</span>
      </div>
      <span class="gm-status"></span>
      <div class="gm-actions"></div>
    `

    this.statusEl = this.root.querySelector('.gm-status')!
    const actions = this.root.querySelector('.gm-actions')!

    for (const phase of PHASES) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.innerHTML = `<span class="gm-btn-label">${phase.label}</span><span class="gm-btn-hint">${phase.hint}</span>`
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        this.controller.jumpTo(phase.id)
        this.refreshStatus()
      })
      actions.appendChild(btn)
    }

    this.root.addEventListener('pointerdown', (e) => e.stopPropagation())
    this.root.addEventListener('click', (e) => e.stopPropagation())

    this.onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Backquote' || e.repeat) return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      e.preventDefault()
      this.toggle()
    }
  }

  private onKeyDown: (e: KeyboardEvent) => void

  mount(parent: HTMLElement): void {
    parent.style.position = parent.style.position || 'relative'
    parent.appendChild(this.root)
    window.addEventListener('keydown', this.onKeyDown)
    this.refreshStatus()
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    this.root.remove()
  }

  toggle(): void {
    this.visible = !this.visible
    this.root.classList.toggle('open', this.visible)
    if (this.visible) this.refreshStatus()
  }

  refreshStatus(): void {
    const state = this.controller.getStateId() ?? '—'
    const mode = this.controller.getRenderMode()
    this.statusEl.textContent = `状态: ${state} · 渲染: ${mode}`
  }
}
