import AmmoFactory from './ammo.worker.es.js'
import ammoWasm from '../../public/assets/dice-box/ammo/ammo.wasm.wasm'
import defaultMeshData from '../../public/assets/dice-box/themes/default/default.json'
import defaultThemeConfig from '../../public/assets/dice-box/themes/default/theme.config.json'
import smoothMeshData from '../../public/assets/dice-box/themes/smooth/smoothDice.json'
import smoothThemeConfig from '../../public/assets/dice-box/themes/smooth/theme.config.json'
import { simulateRollWithLoaders } from '../../server/roll-simulator-core.js'

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
}

let ammoPromise
const themeDataCache = new Map()
const bundledThemes = {
	default: {
		meshData: defaultMeshData,
		themeConfig: defaultThemeConfig,
	},
	smooth: {
		meshData: smoothMeshData,
		themeConfig: smoothThemeConfig,
	},
}

const numberParam = (params, key) => {
	const value = params.get(key)
	if (value === null || value === '') {
		return undefined
	}
	const number = Number(value)
	return Number.isFinite(number) ? number : undefined
}

const getNotation = params => {
	const notation = params.get('notation') || params.get('roll')
	if (notation) {
		return notation
	}
	const dice = params.getAll('dice').filter(Boolean)
	return dice.length ? dice : undefined
}

const jsonResponse = (data, init = {}) => {
	const headers = new Headers(init.headers)
	headers.set('Content-Type', 'application/json; charset=utf-8')
	headers.set('Cache-Control', 'no-store')
	Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value))

	return new Response(JSON.stringify(data), {
		...init,
		headers,
	})
}

const instantiateWasmModule = (moduleOrBytes, imports, receiveInstance) => {
	const instancePromise = moduleOrBytes instanceof WebAssembly.Module
		? WebAssembly.instantiate(moduleOrBytes, imports)
		: WebAssembly.instantiate(moduleOrBytes, imports).then(result => result.instance || result)

	instancePromise.then(receiveInstance)
	return {}
}

const getAmmo = async () => {
	if (!ammoPromise) {
		ammoPromise = AmmoFactory.call(globalThis, {
			instantiateWasm(imports, receiveInstance) {
				return instantiateWasmModule(ammoWasm, imports, receiveInstance)
			},
		})
	}
	return ammoPromise
}

const clone = value => JSON.parse(JSON.stringify(value))

const buildThemeData = theme => {
	if (themeDataCache.has(theme)) {
		return themeDataCache.get(theme)
	}

	const bundle = bundledThemes[theme]
	if (!bundle) {
		throw new Error(`Cloudflare Worker roll simulation bundles only 'default' and 'smooth' themes. Received '${theme}'.`)
	}

	const { meshData, themeConfig } = bundle
	const meshFile = themeConfig.meshFile || 'default.json'
	const meshName = themeConfig.meshName || meshFile.replace(/(.*)\..{2,4}$/, '$1')
	const colliderFaceMap = clone(meshData.colliderFaceMap)
	const colliders = meshData.meshes
		.filter(model => model.name.includes('collider'))
		.map(model => ({ ...model }))

	if (!themeConfig.diceAvailable) {
		throw new Error(`Theme '${theme}' does not define diceAvailable.`)
	}
	if (!colliderFaceMap) {
		throw new Error(`Theme '${theme}' mesh '${meshFile}' does not include colliderFaceMap data.`)
	}

	const hasD10 = colliders.some(model => model.id === 'd10_collider')
	const hasD100 = colliders.some(model => model.id === 'd100_collider')

	if (!hasD100 && hasD10) {
		const d10Collider = colliders.find(model => model.id === 'd10_collider')
		colliders.push({ ...d10Collider, id: 'd100_collider', name: 'd100_collider' })
		colliderFaceMap.d100 = clone(colliderFaceMap.d10)
		Object.keys(colliderFaceMap.d100).forEach(key => {
			const value = colliderFaceMap.d100[key]
			colliderFaceMap.d100[key] = value * (value === 10 ? 0 : 10)
		})
	}

	const themeData = {
		...themeConfig,
		theme,
		basePath: `/assets/dice-box/themes/${theme}`,
		meshFilePath: meshFile,
		meshName,
		colliders,
		colliderFaceMap,
		d4FaceDown: true,
	}
	themeDataCache.set(theme, themeData)
	return themeData
}

const loadThemeData = async ({ theme = 'default' }) => {
	return buildThemeData(theme)
}

const simulateFromRequest = request => {
	const url = new URL(request.url)
	const params = url.searchParams

	return simulateRollWithLoaders({
		notation: getNotation(params),
		theme: params.get('theme') || undefined,
		themeColor: params.get('themeColor') || undefined,
		seed: params.get('seed') || undefined,
		width: numberParam(params, 'width'),
		height: numberParam(params, 'height'),
		scale: numberParam(params, 'scale'),
		frameRate: numberParam(params, 'frameRate'),
		delay: numberParam(params, 'delay'),
		maxDurationMs: numberParam(params, 'maxDurationMs'),
		settleTimeout: numberParam(params, 'settleTimeout'),
		gravity: numberParam(params, 'gravity'),
		mass: numberParam(params, 'mass'),
		spinForce: numberParam(params, 'spinForce'),
		throwForce: numberParam(params, 'throwForce'),
		getAmmo,
		loadThemeData,
	})
}

export default {
	async fetch(request) {
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: corsHeaders,
			})
		}

		const url = new URL(request.url)
		if (url.pathname !== '/api/roll') {
			return jsonResponse({
				ok: true,
				endpoints: {
					roll: '/api/roll?notation=2d20',
				},
			})
		}

		if (request.method !== 'GET') {
			return jsonResponse({ error: 'Method Not Allowed' }, {
				status: 405,
				headers: {
					Allow: 'GET, OPTIONS',
				},
			})
		}

		try {
			const payload = await simulateFromRequest(request)
			return jsonResponse(payload)
		} catch (error) {
			return jsonResponse({
				error: error.message || 'Unable to simulate roll',
			}, {
				status: error.statusCode || 400,
			})
		}
	},
}
