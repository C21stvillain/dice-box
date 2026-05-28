import AmmoFactory from './ammo.worker.es.js'
import ammoWasm from '../../public/assets/dice-box/ammo/ammo.wasm.wasm'
import defaultMeshData from '../../public/assets/dice-box/themes/default/default.json'
import defaultThemeConfig from '../../public/assets/dice-box/themes/default/theme.config.json'
import { simulateRollWithLoaders } from '../../server/roll-simulator-core.js'

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
}

let ammoPromise
let defaultThemeData

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

const buildDefaultThemeData = () => {
	if (defaultThemeData) {
		return defaultThemeData
	}

	const meshFile = defaultThemeConfig.meshFile || 'default.json'
	const meshName = meshFile.replace(/(.*)\..{2,4}$/, '$1')
	const colliderFaceMap = clone(defaultMeshData.colliderFaceMap)
	const colliders = defaultMeshData.meshes
		.filter(model => model.name.includes('collider'))
		.map(model => ({ ...model }))

	if (!defaultThemeConfig.diceAvailable) {
		throw new Error("Theme 'default' does not define diceAvailable.")
	}
	if (!colliderFaceMap) {
		throw new Error("Theme 'default' mesh 'default.json' does not include colliderFaceMap data.")
	}

	defaultThemeData = {
		...defaultThemeConfig,
		theme: 'default',
		basePath: '/assets/dice-box/themes/default',
		meshFilePath: 'default.json',
		meshName,
		colliders,
		colliderFaceMap,
		d4FaceDown: true,
	}
	return defaultThemeData
}

const loadThemeData = async ({ theme = 'default' }) => {
	if (theme !== 'default') {
		throw new Error(`Cloudflare Worker roll simulation currently bundles only the 'default' theme. Received '${theme}'.`)
	}
	return buildDefaultThemeData()
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
