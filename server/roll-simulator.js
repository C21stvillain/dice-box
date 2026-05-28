import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { simulateRollWithLoaders } from './roll-simulator-core.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const defaultAssetRoot = path.join(projectRoot, 'public', 'assets', 'dice-box')
const require = createRequire(import.meta.url)

const ammoCache = new Map()
const themeCache = new Map()
let ammoFactoryPromise

const readJson = async filePath => JSON.parse(await fs.readFile(filePath, 'utf8'))

const loadAmmoFactory = async () => {
	if (!ammoFactoryPromise) {
		ammoFactoryPromise = fs.readFile(path.join(projectRoot, 'src', 'ammo', 'ammo.wasm.es.js'), 'utf8').then(source => {
			const wrappedSource = source.replace('export default function', 'return function')
			return new Function('__dirname', '__filename', 'require', wrappedSource)(
				path.join(projectRoot, 'src', 'ammo'),
				path.join(projectRoot, 'src', 'ammo', 'ammo.wasm.es.js'),
				require,
			)
		})
	}
	return ammoFactoryPromise
}

const getAmmo = async (assetRoot = defaultAssetRoot) => {
	const cacheKey = path.resolve(assetRoot)
	if (!ammoCache.has(cacheKey)) {
		ammoCache.set(cacheKey, fs.readFile(path.join(cacheKey, 'ammo', 'ammo.wasm.wasm')).then(wasmBinary => {
			return loadAmmoFactory().then(AmmoFactory => {
				return AmmoFactory.call(globalThis, { wasmBinary })
			})
		}))
	}
	return ammoCache.get(cacheKey)
}

const loadThemeData = async ({ theme = 'default', assetRoot = defaultAssetRoot }) => {
	const cacheKey = `${path.resolve(assetRoot)}:${theme}`
	if (themeCache.has(cacheKey)) {
		return themeCache.get(cacheKey)
	}

	const themeRoot = path.join(assetRoot, 'themes', theme)
	const themeConfig = await readJson(path.join(themeRoot, 'theme.config.json'))
	const meshFile = themeConfig.meshFile || 'default.json'
	const meshName = meshFile.replace(/(.*)\..{2,4}$/, '$1')
	const meshFilePath = path.join(themeRoot, meshFile)
	const meshData = await readJson(meshFilePath)

	if (!themeConfig.diceAvailable) {
		throw new Error(`Theme '${theme}' does not define diceAvailable.`)
	}
	if (!meshData.colliderFaceMap) {
		throw new Error(`Theme '${theme}' mesh '${meshFile}' does not include colliderFaceMap data.`)
	}

	const colliders = meshData.meshes.filter(model => model.name.includes('collider'))
	const hasD10 = colliders.some(model => model.id === 'd10_collider')
	const hasD100 = colliders.some(model => model.id === 'd100_collider')

	if (!hasD100 && hasD10) {
		const d10Collider = colliders.find(model => model.id === 'd10_collider')
		colliders.push({ ...d10Collider, id: 'd100_collider', name: 'd100_collider' })
		meshData.colliderFaceMap.d100 = JSON.parse(JSON.stringify(meshData.colliderFaceMap.d10))
		Object.keys(meshData.colliderFaceMap.d100).forEach(key => {
			const value = meshData.colliderFaceMap.d100[key]
			meshData.colliderFaceMap.d100[key] = value * (value === 10 ? 0 : 10)
		})
	}

	const themeData = {
		...themeConfig,
		theme,
		basePath: `/assets/dice-box/themes/${theme}`,
		meshFilePath,
		meshName,
		colliders,
		colliderFaceMap: meshData.colliderFaceMap,
		d4FaceDown: true,
	}
	themeCache.set(cacheKey, themeData)
	return themeData
}

export const simulateRoll = async ({ assetRoot = defaultAssetRoot, ...options }) => {
	return simulateRollWithLoaders({
		...options,
		getAmmo: () => getAmmo(assetRoot),
		loadThemeData: ({ theme }) => loadThemeData({ theme, assetRoot }),
	})
}

export { parseRollNotation } from './roll-simulator-core.js'
export const defaultRollAssetRoot = defaultAssetRoot
