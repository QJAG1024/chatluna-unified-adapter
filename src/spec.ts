import {
    getModelMaxContextSizeByName,
    supportAudioInput,
    supportImageInput
} from '@chatluna/v1-shared-adapter'
import {
    ModelCapabilities,
    ModelInfo,
    ModelType
} from 'koishi-plugin-chatluna/llm-core/platform/types'
import { ModelSpec } from './catalog'

/**
 * How a model id plus its metadata becomes the ModelInfo chatluna consumes.
 *
 * Precedence is fixed and applied per field (docs/ARCHITECTURE.md §3): the
 * user's override, then the catalog, then chatluna's existing heuristics,
 * then a conservative default. Nothing here guesses at a vendor.
 */

/** A user override, as stored in the config dict. */
export interface Override {
    modelType?: string
    modelCapabilities?: ModelCapabilities[]
    contextSize?: number
    maxOutputTokens?: number
}

/** One assembled model: the ModelInfo plus the output ceiling to fall back on. */
export interface Spec {
    info: ModelInfo
    output?: number
}

/** What the declared input modalities imply, keyed by catalog initial. */
const MODALITY_CAPABILITIES: Record<string, ModelCapabilities> = {
    i: ModelCapabilities.ImageInput,
    p: ModelCapabilities.FileInput,
    a: ModelCapabilities.AudioInput,
    v: ModelCapabilities.VideoInput
}

export function specOf(
    name: string,
    override: Override | undefined,
    meta: ModelSpec | undefined,
    fillCapabilities: boolean
): Spec {
    const type =
        override?.modelType != null
            ? modelTypeOf(override.modelType)
            : modelTypeOf(meta?.type)

    return {
        info: {
            name,
            type,
            // chatluna reads maxTokens as the context window. An unknown model
            // keeps the fallback shared-adapter already assumes, so this
            // adapter never disagrees with the existing ones.
            maxTokens:
                override?.contextSize ??
                meta?.context ??
                getModelMaxContextSizeByName(name),
            // The schema materializes an untouched checkbox list as `[]`, so an
            // empty array means "not set" — same as an absent field.
            capabilities:
                (override?.modelCapabilities?.length ?? 0) > 0
                    ? override.modelCapabilities
                    : fillCapabilities
                      ? capabilitiesOf(name, meta, type)
                      : []
        },
        output: override?.maxOutputTokens ?? meta?.output
    }
}

/** models.dev `type` and the config enum both collapse onto ModelType. */
function modelTypeOf(type: string | undefined) {
    switch (type) {
        case 'embedding':
        case 'Embeddings 嵌入模型':
            return ModelType.embeddings
        case 'reranking':
        case 'Reranker 重排序模型':
            return ModelType.reranker
        default:
            return ModelType.llm
    }
}

function capabilitiesOf(
    name: string,
    meta: ModelSpec | undefined,
    type: ModelType
) {
    if (type !== ModelType.llm) return []

    const result = new Set<ModelCapabilities>()

    // Tool calling is what the existing adapters grant by default; only a
    // catalog record that positively denies it takes it away.
    if (meta?.toolCall !== false) result.add(ModelCapabilities.ToolCall)
    if (meta?.reasoning) result.add(ModelCapabilities.Thinking)

    // A record that declares modalities answers for them; one that does not
    // (or is absent) leaves the question to chatluna's existing matchers.
    if (meta?.modalities != null) {
        for (const char of meta.modalities) {
            const capability = MODALITY_CAPABILITIES[char]
            if (capability != null) result.add(capability)
        }
    } else {
        if (supportImageInput(name)) result.add(ModelCapabilities.ImageInput)
        if (supportAudioInput(name)) result.add(ModelCapabilities.AudioInput)
    }

    return [...result]
}
