import { isClaudeModelPreset } from '@hapi/protocol'

/**
 * Context windows vary by model/provider and may change over time.
 *
 * The UI only needs this to compute a conservative "context remaining" warning.
 * We intentionally keep a headroom budget to avoid false confidence near the limit
 * (system prompts, tool overhead, and other hidden tokens can consume extra space).
 *
 * If/when the server provides an explicit per-session context limit, prefer that
 * and use this only as a fallback.
 */
const CONTEXT_HEADROOM_TOKENS = 10_000
const DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS = 200_000
const LARGE_CLAUDE_CONTEXT_WINDOW_TOKENS = 1_000_000
// Fallback for Codex sessions when the server has not reported an explicit modelContextWindow.
// The value matches the context window currently reported by Codex App Server token-count events.
const DEFAULT_CODEX_CONTEXT_WINDOW_TOKENS = 258_400
// Pi supports multiple providers with varying context windows. 200K is a
// conservative default (most Claude/GPT-4 class models). When the server
// reports an explicit modelContextWindow via usage events, that takes
// precedence over this fallback.
const DEFAULT_PI_CONTEXT_WINDOW_TOKENS = 200_000

function parseCursorWireContextWindow(model: string): number | null {
    const match = model.match(/\[([^\]]+)\]/)
    if (!match) {
        return null
    }
    for (const segment of match[1].split(',')) {
        const part = segment.trim()
        const eq = part.indexOf('=')
        if (eq === -1 || part.slice(0, eq).trim() !== 'context') {
            continue
        }
        const raw = part.slice(eq + 1).trim().toLowerCase()
        const digits = raw.match(/(\d+)/)?.[1]
        if (!digits) {
            return null
        }
        const value = Number.parseInt(digits, 10)
        if (!Number.isFinite(value) || value <= 0) {
            return null
        }
        return raw.endsWith('k') ? value * 1000 : value
    }
    return null
}

// Bedrock / Vertex style ids (e.g. "global.anthropic.claude-opus-5-5[1m]",
// "us.anthropic.claude-sonnet-5-5") name the same models as "claude-*".
function stripClaudeProviderPrefix(model: string): string {
    return model.replace(/^(?:[a-z]+\.)?anthropic\./, '')
}

function getClaudeModelFamily(model: string): string | null {
    return /(opus|sonnet|haiku|fable)/i.exec(model)?.[1]?.toLowerCase() ?? null
}

/**
 * Pick the model used for the Claude context-window heuristic. Transcript usage
 * reports the bare API id without "[1m]", so a 1M session would be measured
 * against 200k. Prefer the session's configured model when it carries the 1M
 * suffix and names the same family as the usage-bearing message.
 */
export function pickClaudeContextModel(
    usageModel: string | null | undefined,
    sessionModel: string | null | undefined
): string | null | undefined {
    if (!usageModel) return sessionModel
    if (!sessionModel?.trim().endsWith('[1m]') || usageModel.trim().endsWith('[1m]')) return usageModel
    const usageFamily = getClaudeModelFamily(usageModel)
    return usageFamily && usageFamily === getClaudeModelFamily(sessionModel) ? sessionModel : usageModel
}

export function getContextBudgetTokens(model: string | null | undefined, flavor?: string | null): number | null {
    if (flavor === 'codex') {
        return Math.max(1, DEFAULT_CODEX_CONTEXT_WINDOW_TOKENS - CONTEXT_HEADROOM_TOKENS)
    }

    if (flavor === 'pi') {
        return Math.max(1, DEFAULT_PI_CONTEXT_WINDOW_TOKENS - CONTEXT_HEADROOM_TOKENS)
    }

    if (flavor === 'cursor') {
        const trimmedModel = model?.trim()
        const windowTokens = trimmedModel ? parseCursorWireContextWindow(trimmedModel) : null
        if (!windowTokens) {
            return null
        }
        return Math.max(1, windowTokens - CONTEXT_HEADROOM_TOKENS)
    }

    if (flavor !== 'claude') {
        return null
    }

    const trimmedModel = model?.trim() ? stripClaudeProviderPrefix(model.trim()) : undefined
    const windowTokens = (() => {
        if (!trimmedModel) {
            return DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS
        }
        if (isClaudeModelPreset(trimmedModel) || trimmedModel.startsWith('claude-')) {
            // Fable ships with a 1M window even under its bare id: the SDK
            // result message reports modelUsage["claude-fable-5"].contextWindow
            // = 1,000,000, so the "[1m]" suffix check alone would undercount
            // local-mode sessions (their transcript usage carries no
            // context_window and falls through to this heuristic).
            const isFable = trimmedModel === 'fable'
                || trimmedModel === 'fable[1m]'
                || trimmedModel.startsWith('claude-fable')
            return trimmedModel.endsWith('[1m]') || isFable
                ? LARGE_CLAUDE_CONTEXT_WINDOW_TOKENS
                : DEFAULT_CLAUDE_CONTEXT_WINDOW_TOKENS
        }
        return null
    })()

    if (!windowTokens) return null
    return Math.max(1, windowTokens - CONTEXT_HEADROOM_TOKENS)
}
