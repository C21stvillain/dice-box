import { simulateRoll } from './roll-simulator.js'

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

const handleRollApi = async (req, res, next) => {
	const url = new URL(req.url, 'http://localhost')
	if (url.pathname !== '/api/roll') {
		next()
		return
	}

	if (req.method !== 'GET') {
		res.statusCode = 405
		res.setHeader('Allow', 'GET')
		res.end('Method Not Allowed')
		return
	}

	try {
		const payload = await simulateRoll({
			notation: getNotation(url.searchParams),
			theme: url.searchParams.get('theme') || undefined,
			themeColor: url.searchParams.get('themeColor') || undefined,
			seed: url.searchParams.get('seed') || undefined,
			width: numberParam(url.searchParams, 'width'),
			height: numberParam(url.searchParams, 'height'),
			scale: numberParam(url.searchParams, 'scale'),
			frameRate: numberParam(url.searchParams, 'frameRate'),
			delay: numberParam(url.searchParams, 'delay'),
			maxDurationMs: numberParam(url.searchParams, 'maxDurationMs'),
			settleTimeout: numberParam(url.searchParams, 'settleTimeout'),
			gravity: numberParam(url.searchParams, 'gravity'),
			mass: numberParam(url.searchParams, 'mass'),
			spinForce: numberParam(url.searchParams, 'spinForce'),
			throwForce: numberParam(url.searchParams, 'throwForce'),
		})

		res.statusCode = 200
		res.setHeader('Content-Type', 'application/json; charset=utf-8')
		res.setHeader('Cache-Control', 'no-store')
		res.end(JSON.stringify(payload))
	} catch (error) {
		res.statusCode = error.statusCode || 400
		res.setHeader('Content-Type', 'application/json; charset=utf-8')
		res.end(JSON.stringify({
			error: error.message || 'Unable to simulate roll',
		}))
	}
}

export default function rollApiPlugin() {
	return {
		name: 'dice-box-roll-api',
		configureServer(server) {
			server.middlewares.use(handleRollApi)
		},
		configurePreviewServer(server) {
			server.middlewares.use(handleRollApi)
		},
	}
}
