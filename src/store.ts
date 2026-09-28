import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { sampleScript } from './sample'
import type { BlockedScene, Character, ContinuityState, DiffItem, Prop, Reply, Scene, Script, ShootUnit, UnitReviewResult, Version, Wardrobe, WarningItem, WarningReview } from './types'

const STORAGE_KEY = 'sologsb-1017-continuity-v1'
const clone = <T,>(value: T): T => structuredClone(value)
const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

function initialState(): ContinuityState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as ContinuityState
      if (parsed.script?.scenes?.length) return parsed
    }
  } catch {
    // Ignore an invalid local draft and restore the bundled example.
  }
  return { script: clone(sampleScript), reviews: {}, versions: [], updatedAt: new Date().toISOString() }
}

export function deriveWarnings(script: Script): WarningItem[] {
  const warnings: WarningItem[] = []
  const sceneIndex = (sceneId: string) => script.scenes.findIndex((scene) => scene.id === sceneId)
  const charactersSeen = new Set<string>()
  const propsSeen = new Set<string>()

  script.scenes.forEach((scene, index) => {
    scene.characterIds.forEach((characterId) => {
      const character = script.characters.find((item) => item.id === characterId)
      if (!character) return
      const introducedAt = sceneIndex(character.introducedSceneId)
      if (index > 0 && !charactersSeen.has(characterId) && introducedAt >= index) {
        warnings.push({
          id: `character-${scene.id}-${characterId}`,
          type: 'character',
          severity: index > 1 ? 'error' : 'warning',
          sceneId: scene.id,
          title: `${character.name}突然出现`,
          detail: `角色在场景 ${scene.number} 首次出现，但前序场景没有建立其身份、关系或到场铺垫。`,
          suggestion: `在更早场景补充提及、声音或到场动作，并把“首次建立”场景改为相应场次。`
        })
      }
      charactersSeen.add(characterId)
    })

    scene.propIds.forEach((propId) => {
      const prop = script.props.find((item) => item.id === propId)
      if (!prop) return
      const introducedAt = sceneIndex(prop.introducedSceneId)
      if (!propsSeen.has(propId) && introducedAt > index) {
        warnings.push({
          id: `prop-${scene.id}-${propId}`,
          type: 'prop',
          severity: 'error',
          sceneId: scene.id,
          title: `${prop.name}尚未提前建立`,
          detail: `道具在场景 ${scene.number} 已出现，但首次建立被标记在场景 ${script.scenes[introducedAt]?.number ?? '未知'}。`,
          suggestion: '调整首次建立场景，或在当前场景加入来源、交接动作与持有人反应。'
        })
      }
      propsSeen.add(propId)
    })

    Object.entries(scene.costumes).forEach(([characterId, wardrobeId]) => {
      const wardrobe = script.wardrobes.find((item) => item.id === wardrobeId)
      const character = script.characters.find((item) => item.id === characterId)
      if (!wardrobe || !character) return
      if (!wardrobe.timePeriods.includes(scene.dayNight)) {
        warnings.push({
          id: `wardrobe-${scene.id}-${characterId}-${wardrobeId}`,
          type: 'wardrobe',
          severity: 'warning',
          sceneId: scene.id,
          title: `${character.name}服装与时间冲突`,
          detail: `“${wardrobe.name}”只配置用于 ${wardrobe.timePeriods.join('、')}，本场标记为“${scene.dayNight}”。`,
          suggestion: '确认是否跨越时间连续拍摄；如需延续服装，请把当前时段加入服装适用范围。'
        })
      }
    })

    if (index > 0 && script.scenes[index - 1].storyTime && scene.storyTime && index > 0) {
      const previous = script.scenes[index - 1]
      const previousDay = previous.storyTime.match(/第\s*(\d+)\s*天/)?.[1]
      const currentDay = scene.storyTime.match(/第\s*(\d+)\s*天/)?.[1]
      if (previousDay && currentDay && Number(currentDay) < Number(previousDay)) {
        warnings.push({
          id: `timeline-${scene.id}`,
          type: 'timeline',
          severity: 'error',
          sceneId: scene.id,
          title: '时间线出现倒退',
          detail: `上一场为第 ${previousDay} 天，本场却标记为第 ${currentDay} 天，可能造成观看顺序混乱。`,
          suggestion: '调整故事时间，或明确使用倒叙并在场次摘要中标注时间跳转。'
        })
      }
    }
  })
  return warnings
}

export function parseStoryDay(storyTime: string): number | null {
  const match = storyTime.match(/第\s*(\d+)\s*天/)
  return match ? Number(match[1]) : null
}

/**
 * 连拍单元：相邻场次中故事时间属同一天、且地点与日夜完全一致的归入同一组。
 * 故事时间无法解析出“第 N 天”的场次自成单元，不会与邻场合并。
 * 顺序或时间一改，这里随脚本重新计算，所以不需要持久化单元本身。
 */
export function deriveShootUnits(scenes: Scene[]): ShootUnit[] {
  const units: ShootUnit[] = []
  scenes.forEach((scene, index) => {
    const day = parseStoryDay(scene.storyTime)
    const previous = units[units.length - 1]
    const previousScene = scenes[index - 1]
    const sameUnit =
      day !== null &&
      previous &&
      previous.storyDay === day &&
      previousScene?.location === scene.location &&
      previousScene?.dayNight === scene.dayNight
    if (sameUnit) previous.scenes.push(scene)
    else units.push({ id: `unit-${units.length}`, storyDay: day, scenes: [scene] })
  })
  return units
}

export function diffScript(base: Script, current: Script): DiffItem[] {
  const fields: Array<{ key: keyof Scene; label: string }> = [
    { key: 'slug', label: '场名' },
    { key: 'synopsis', label: '摘要' },
    { key: 'intExt', label: '内外景' },
    { key: 'location', label: '地点' },
    { key: 'dayNight', label: '日夜' },
    { key: 'storyTime', label: '故事时间' },
    { key: 'pageLength', label: '页数' },
    { key: 'revision', label: '修订色' },
    { key: 'status', label: '状态' },
    { key: 'reason', label: '修改理由' }
  ]
  const result: DiffItem[] = []
  const sceneKey = (scene: Scene) => `${scene.number}|${scene.slug}`
  const baseByKey = new Map(base.scenes.map((scene) => [sceneKey(scene), scene]))
  current.scenes.forEach((scene) => {
    const previous = baseByKey.get(sceneKey(scene)) ?? base.scenes.find((item) => item.id === scene.id)
    if (!previous) {
      result.push({ id: `new-${scene.id}`, sceneNumber: scene.number, field: '场次', before: '不存在', after: `${scene.intExt}. ${scene.location} — ${scene.dayNight}` })
      return
    }
    fields.forEach(({ key, label }) => {
      const before = String(previous[key] ?? '')
      const after = String(scene[key] ?? '')
      if (before !== after) result.push({ id: `${scene.id}-${String(key)}`, sceneNumber: scene.number, field: label, before, after })
    })
  })
  base.scenes.forEach((scene) => {
    if (!current.scenes.some((item) => item.id === scene.id || sceneKey(item) === sceneKey(scene))) {
      result.push({ id: `deleted-${scene.id}`, sceneNumber: scene.number, field: '场次', before: `${scene.intExt}. ${scene.location} — ${scene.dayNight}`, after: '已删除' })
    }
  })
  return result
}

export function useContinuityStore() {
  const [state, setState] = useState<ContinuityState>(initialState)
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving'>('saved')
  const undoRef = useRef<Array<Pick<ContinuityState, 'script' | 'reviews'>>>([])
  const redoRef = useRef<Array<Pick<ContinuityState, 'script' | 'reviews'>>>([])
  const saveTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    setSaveStatus('saving')
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
      setSaveStatus('saved')
    }, 160)
    return () => window.clearTimeout(saveTimer.current)
  }, [state])

  // 所有可撤销的修改都走这里：历史栈同时保存剧本与审阅决定，
  // 因此整组接受/忽略和逐条审阅一样可以撤销、重做并随本地保存保留。
  const commit = useCallback((producer: (draft: ContinuityState) => void) => {
    setState((previous) => {
      undoRef.current.push({ script: clone(previous.script), reviews: clone(previous.reviews) })
      if (undoRef.current.length > 80) undoRef.current.shift()
      redoRef.current = []
      const next = clone(previous)
      producer(next)
      next.updatedAt = new Date().toISOString()
      return next
    })
  }, [])

  const mutate = useCallback((mutator: (script: Script) => void) => {
    commit((draft) => { mutator(draft.script) })
  }, [commit])

  const undo = useCallback(() => {
    setState((previous) => {
      const target = undoRef.current.pop()
      if (!target) return previous
      redoRef.current.push({ script: clone(previous.script), reviews: clone(previous.reviews) })
      return { ...previous, script: target.script, reviews: target.reviews, updatedAt: new Date().toISOString() }
    })
  }, [])

  const redo = useCallback(() => {
    setState((previous) => {
      const target = redoRef.current.pop()
      if (!target) return previous
      undoRef.current.push({ script: clone(previous.script), reviews: clone(previous.reviews) })
      return { ...previous, script: target.script, reviews: target.reviews, updatedAt: new Date().toISOString() }
    })
  }, [])

  const updateScriptField = useCallback((field: 'title' | 'writer' | 'draft', value: string) => {
    mutate((script) => { script[field] = value })
  }, [mutate])

  const updateScene = useCallback((sceneId: string, field: keyof Scene, value: Scene[keyof Scene]) => {
    mutate((script) => {
      const scene = script.scenes.find((item) => item.id === sceneId)
      if (scene) (scene as unknown as Record<string, unknown>)[field] = value
    })
  }, [mutate])

  const toggleSceneRelation = useCallback((sceneId: string, field: 'characterIds' | 'propIds', itemId: string) => {
    mutate((script) => {
      const scene = script.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      const values = scene[field]
      scene[field] = values.includes(itemId) ? values.filter((value) => value !== itemId) : [...values, itemId]
    })
  }, [mutate])

  const setCostume = useCallback((sceneId: string, characterId: string, wardrobeId: string) => {
    mutate((script) => {
      const scene = script.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      if (!wardrobeId) delete scene.costumes[characterId]
      else scene.costumes[characterId] = wardrobeId
    })
  }, [mutate])

  const moveScene = useCallback((sceneId: string, direction: -1 | 1) => {
    mutate((script) => {
      const index = script.scenes.findIndex((scene) => scene.id === sceneId)
      const target = index + direction
      if (index < 0 || target < 0 || target >= script.scenes.length) return
      const [scene] = script.scenes.splice(index, 1)
      script.scenes.splice(target, 0, scene)
    })
  }, [mutate])

  const addScene = useCallback(() => {
    const sceneId = id('scene')
    mutate((script) => {
      const number = String(script.scenes.length + 1)
      script.scenes.push({
        id: sceneId, number, slug: '未命名场景', synopsis: '', intExt: 'INT', location: '待填写', dayNight: '白天', storyTime: `第 1 天`, pageLength: 1,
        characterIds: [], propIds: [], costumes: {}, revision: 'white', status: 'draft', reason: ''
      })
    })
    return sceneId
  }, [mutate])

  const deleteScene = useCallback((sceneId: string) => {
    if (state.script.scenes.length <= 1) return
    mutate((script) => { script.scenes = script.scenes.filter((scene) => scene.id !== sceneId) })
  }, [mutate, state.script.scenes.length])

  const addCharacter = useCallback(() => {
    mutate((script) => {
      script.characters.push({ id: id('char'), name: '新角色', actor: '待定', introducedSceneId: script.scenes[0]?.id ?? '', note: '' })
    })
  }, [mutate])

  const updateCharacter = useCallback((characterId: string, field: keyof Character, value: string) => {
    mutate((script) => {
      const item = script.characters.find((character) => character.id === characterId)
      if (item) item[field] = value
    })
  }, [mutate])

  const addProp = useCallback(() => {
    mutate((script) => {
      script.props.push({ id: id('prop'), name: '新道具', introducedSceneId: script.scenes[0]?.id ?? '', ownerId: script.characters[0]?.id ?? '', note: '' })
    })
  }, [mutate])

  const updateProp = useCallback((propId: string, field: keyof Prop, value: string) => {
    mutate((script) => {
      const item = script.props.find((prop) => prop.id === propId)
      if (item) item[field] = value
    })
  }, [mutate])

  const addWardrobe = useCallback(() => {
    mutate((script) => {
      script.wardrobes.push({ id: id('ward'), characterId: script.characters[0]?.id ?? '', name: '新服装', timePeriods: ['白天'], note: '' })
    })
  }, [mutate])

  const updateWardrobe = useCallback((wardrobeId: string, field: keyof Wardrobe, value: string | string[]) => {
    mutate((script) => {
      const item = script.wardrobes.find((wardrobe) => wardrobe.id === wardrobeId)
      if (item) {
        if (field === 'timePeriods') item.timePeriods = value as string[]
        else item[field] = value as never
      }
    })
  }, [mutate])

  const setReviewStatus = useCallback((warningId: string, status: WarningReview['status']) => {
    commit((draft) => {
      draft.reviews[warningId] = { ...(draft.reviews[warningId] ?? { replies: [] }), status }
    })
  }, [commit])

  const reviewShootUnit = useCallback((unit: ShootUnit, status: WarningReview['status']): UnitReviewResult => {
    const blocked: BlockedScene[] = unit.scenes.flatMap((scene) => {
      const reasons: BlockedScene['reasons'] = []
      if (scene.status === 'locked') reasons.push('locked')
      if (!scene.reason.trim()) reasons.push('missing-reason')
      return reasons.length ? [{ sceneId: scene.id, number: scene.number, slug: scene.slug, reasons }] : []
    })
    if (blocked.length) return { ok: false, blocked, applied: 0 }

    // 用当前脚本即时推导组内问题（保证与界面看到的单元一致），提交时只做状态写入。
    const unitSceneIds = new Set(unit.scenes.map((scene) => scene.id))
    const unitWarnings = deriveWarnings(state.script).filter((warning) => unitSceneIds.has(warning.sceneId))
    const applied = unitWarnings.filter((warning) => (state.reviews[warning.id]?.status ?? 'pending') !== status).length
    commit((draft) => {
      unitWarnings.forEach((warning) => {
        draft.reviews[warning.id] = { ...(draft.reviews[warning.id] ?? { replies: [] }), status }
      })
    })
    return { ok: true, blocked, applied }
  }, [commit, state.script, state.reviews])

  const addReply = useCallback((warningId: string, author: string, text: string) => {
    if (!text.trim()) return
    const reply: Reply = { id: id('reply'), author, text: text.trim(), createdAt: new Date().toISOString() }
    setState((previous) => ({
      ...previous,
      reviews: {
        ...previous.reviews,
        [warningId]: {
          status: previous.reviews[warningId]?.status ?? 'pending',
          replies: [...(previous.reviews[warningId]?.replies ?? []), reply]
        }
      },
      updatedAt: new Date().toISOString()
    }))
  }, [])

  const createVersion = useCallback((name: string) => {
    const version: Version = {
      id: id('version'),
      name: name.trim() || `版本 ${state.versions.length + 1}`,
      createdAt: new Date().toISOString(),
      script: clone(state.script),
      reviews: clone(state.reviews)
    }
    setState((previous) => ({ ...previous, versions: [version, ...previous.versions] }))
    return version
  }, [state.script, state.reviews, state.versions.length])

  const restoreVersion = useCallback((versionId: string) => {
    setState((previous) => {
      const version = previous.versions.find((item) => item.id === versionId)
      if (!version) return previous
      // 恢复版本同样可撤销：剧本与审阅决定一起回滚到快照时的状态。
      undoRef.current.push({ script: clone(previous.script), reviews: clone(previous.reviews) })
      redoRef.current = []
      return {
        ...previous,
        script: clone(version.script),
        reviews: clone(version.reviews ?? {}),
        updatedAt: new Date().toISOString()
      }
    })
  }, [])

  const reset = useCallback(() => {
    commit((draft) => {
      Object.assign(draft.script, clone(sampleScript))
      draft.reviews = {}
    })
  }, [commit])

  const shootUnits = useMemo(() => deriveShootUnits(state.script.scenes), [state.script.scenes])

  return {
    state,
    saveStatus,
    warnings: deriveWarnings(state.script),
    shootUnits,
    updateScriptField,
    updateScene,
    toggleSceneRelation,
    setCostume,
    moveScene,
    addScene,
    deleteScene,
    addCharacter,
    updateCharacter,
    addProp,
    updateProp,
    addWardrobe,
    updateWardrobe,
    setReviewStatus,
    reviewShootUnit,
    addReply,
    createVersion,
    restoreVersion,
    undo,
    redo,
    reset
  }
}
