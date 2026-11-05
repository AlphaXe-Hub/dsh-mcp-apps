// @vitest-environment jsdom
// Repro: the section-3 reveal loop in McpAppToolView used to capture its
// MutationObserver and user-gesture listener targets eagerly, on the first
// commit where the iframe exists. The real chat host commits the
// turn-process disclosure around the block on a LATER commit (the production
// code's own comment says the iframe is "not yet inside the Turn disclosure
// on the commit that first renders it"), so that eager binding watches a
// node too deep to ever see the host's fold mutations — leaving only the
// one-shot reveal timers to defend the view, and once those expire the view
// silently disappears when the host folds the completed Turn.
//
// The existing test in client-plugin.spec.ts pre-nests the container inside
// the disclosure before rendering, which hides this race. This spec mounts
// outside first and moves in afterwards, matching the real host commit
// order, and relies on the self-healing binding (bindTarget) to re-bind on
// the timer-driven reveal passes.
import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function makeTool() {
  return {
    publicName: 'analytics_render_chart',
    rawName: 'render_chart',
    resourceUri: 'ui://charts/app',
    serverName: 'analytics',
  }
}

function makeContext(call: ReturnType<typeof vi.fn>) {
  const components = new Map<string, (props: any) => React.ReactElement>()
  const register = vi.fn((descriptor: { key: string }, component: (props: any) => React.ReactElement) => {
    components.set(descriptor.key, component)
    return () => components.delete(descriptor.key)
  })
  const context = {
    connection: {
      rpc: { call },
      generation: { subscribe: () => () => { } },
    },
    slots: {
      inject: (_name: string, effect: () => () => void) => effect(),
      register,
    },
    effect: (effect: () => () => void) => effect(),
  }
  return { context, components }
}

describe('reveal loop vs. the real host commit order', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('re-asserts after the host folds a turn whose disclosure was committed around the block later', async () => {
    const tool = makeTool()
    const html = '<!doctype html><html><body>app</body></html>'
    const call = vi.fn(async (_channel: string, endpoint: string) => endpoint === 'resources/read'
      ? { ok: true as const, value: { uri: tool.resourceUri, html } }
      : { ok: true as const, value: [tool] })
    const fixture = makeContext(call)
    const dispose = apply(fixture.context as never)
    await vi.waitFor(() => expect(fixture.components.get(tool.publicName)).toBeDefined())

    // The turn disclosure exists in the flow, but the tool block (and thus
    // the view container) is NOT inside it yet — mirroring the real host,
    // which commits the disclosure around the block on a later commit.
    const turn = document.createElement('div')
    turn.setAttribute('data-turn-process', 'turn-1')
    const toggle = document.createElement('button')
    toggle.setAttribute('data-turn-process', 'turn-1')
    toggle.setAttribute('data-open', '')
    const member = document.createElement('div')
    turn.append(toggle, member)
    document.body.appendChild(turn)

    const container = document.createElement('div')
    document.body.appendChild(container) // outside the disclosure for now
    // The reveal loop under test is insensitive to iframe load events.
    // Swallow them in the capture phase so jsdom's about:blank + srcDoc
    // double-load (a jsdom-only artifact — Chromium collapses it to a
    // single load because srcDoc is assigned before the first load task
    // runs) cannot trip the component's navigation guard and unmount the
    // view under test.
    container.addEventListener('load', (event) => event.stopPropagation(), true)

    const hostProps = {
      callId: 'call-1',
      toolName: tool.publicName,
      block: {
        kind: 'result',
        callId: 'call-1',
        call: { name: tool.publicName, argsRaw: '{}' },
        isError: false,
        content: [{ type: 'text', text: 'chart ready' }],
        meta: {
          mcpApp: {
            serverName: tool.serverName,
            rawToolName: tool.rawName,
            resourceUri: tool.resourceUri,
            sessionToken: 'session-1',
            result: { content: [{ type: 'text', text: 'chart ready' }] },
          },
        },
      },
      openFile: vi.fn(),
      loadImage: vi.fn(),
    }

    const view = fixture.components.get(tool.publicName)!
    const root: Root = createRoot(container)
    vi.stubGlobal('__PKG_VERSION__', 'test')
    let toggleClicks = 0
    toggle.addEventListener('click', () => {
      toggleClicks += 1
      toggle.setAttribute('data-open', '')
    })

    // 1. The view mounts and its resource resolves while the block is still
    //    outside the disclosure — the reveal effect binds now, to a node
    //    too deep to see the host's later fold mutations.
    await act(async () => {
      root.render(React.createElement(view, hostProps))
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())

    // 2. The host commits the disclosure around the block, then real time
    //    passes: the one-shot reveal timers (300–2500 ms) fire and, with
    //    the self-healing binding, each pass re-resolves the target and
    //    re-binds the observer to the now-enclosing disclosure. (The
    //    turn-end fold in the real host lands several seconds after the
    //    resource loads — after these timers.)
    member.appendChild(container)
    dispose()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_600))
    })

    // 3. The host folds the completed turn on a later commit.
    await act(async () => {
      toggle.removeAttribute('data-open')
      member.setAttribute('hidden', 'until-found')
      await new Promise((resolve) => setTimeout(resolve, 100))
    })

    // The loop must re-assert: wrapper un-hidden, toggle re-opened.
    // A failure here is the "appears then silently disappears" regression.
    expect(member.hasAttribute('hidden')).toBe(false)
    expect(toggle.hasAttribute('data-open')).toBe(true)
    expect(toggleClicks).toBeGreaterThan(0)

    await act(async () => root.unmount())
  })
})
