import type { RawJSONLines } from '@/claude/types'
import { isExternalUserMessage } from '@/api/apiSession'

const MAX_ANCHORS = 50

/**
 * Detects a terminal `/rewind` in the Claude transcript. Claude never removes
 * rewound entries; the next prompt is written with a `parentUuid` pointing at
 * an earlier entry instead of the latest one. When a typed prompt branches like
 * that, return the branch point and its known ancestors (nearest first) so the
 * hub can drop its copy of everything after the nearest one it holds.
 */
export function createTranscriptRewindTracker() {
    const parents = new Map<string, string | null>()
    let lastUuid: string | null = null

    return {
        observe(entry: RawJSONLines): string[] | null {
            const { uuid, parentUuid, isSidechain } = entry as {
                uuid?: unknown
                parentUuid?: unknown
                isSidechain?: unknown
            }
            if (typeof uuid !== 'string' || isSidechain === true) return null
            const parent = typeof parentUuid === 'string' ? parentUuid : null

            let anchors: string[] | null = null
            if (lastUuid && parent && parent !== lastUuid && isExternalUserMessage(entry)) {
                anchors = []
                let current: string | null | undefined = parent
                while (current && anchors.length < MAX_ANCHORS && !anchors.includes(current)) {
                    anchors.push(current)
                    current = parents.get(current)
                }
            }

            parents.set(uuid, parent)
            lastUuid = uuid
            return anchors
        }
    }
}
