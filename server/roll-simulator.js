import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const defaultAssetRoot = path.join(projectRoot, 'public', 'assets', 'dice-box')
const require = createRequire(import.meta.url)

const defaultOptions = {
	width: 800,
	height: 600,
	frameRate: 60,
	size: 9.5,
	startingHeight: 8,
	spinForce: 6,
	throwForce: 5,
	gravity: 1,
	mass: 1,
	friction: .8,
	restitution: .1,
	linearDamping: .5,
	angularDamping: .4,
	settleTimeout: 5000,
	scale: 5,
	delay: 10,
	theme: 'default',
	themeColor: '#2e8555',
	maxDurationMs: 10000,
}

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

const hashSeed = seed => {
	let hash = 2166136261
	const seedString = String(seed)
	for (let i = 0; i < seedString.length; i++) {
		hash ^= seedString.charCodeAt(i)
		hash = Math.imul(hash, 16777619)
	}
	return hash >>> 0
}

const seededRandom = seed => {
	let state = hashSeed(seed)
	return () => {
		state += 0x6D2B79F5
		let t = state
		t = Math.imul(t ^ t >>> 15, t | 1)
		t ^= t + Math.imul(t ^ t >>> 7, t | 61)
		return ((t ^ t >>> 14) >>> 0) / 4294967296
	}
}

const randomRange = (random, min, max) => min + (max - min) * random()

const randomInt = (random, min, max) => Math.floor(randomRange(random, min, max + 1))

const hexToRGB = hex => {
	let value = hex.slice(hex.startsWith('#') ? 1 : 0)
	if (value.length === 3) {
		value = [...value].map(char => char + char).join('')
	}
	const int = parseInt(value, 16)
	return {
		r: int >>> 16,
		g: (int & 0x00ff00) >>> 8,
		b: int & 0x0000ff,
	}
}

const getColorSuffix = (themeData, themeColor) => {
	if (themeData.material?.type !== 'color') {
		return ''
	}
	const color = hexToRGB(themeColor)
	return ((color.r * 0.299 + color.g * 0.587 + color.b * 0.114) > 175) ? '_dark' : '_light'
}

export const parseRollNotation = (input, diceAvailable = []) => {
	const notation = Array.isArray(input)
		? input
		: String(input).split(',').map(part => part.trim()).filter(Boolean)

	const parsedNotation = []
	const diceNotation = /^(\d*)[dD](\d+)(.*)$/i
	const percentNotation = /^(\d*)[dD](00|%)(.*)$/i
	const fudgeNotation = /^(\d*)[dD](f+[ate]*)(.*)$/i
	const customNotation = /^(\d*)[dD]([\d\w]+)([+-]{0,1}\d+)?/i
	const modifier = /([+-])(\d+)/

	const validNumber = (value, fallback, notationText) => {
		const number = value === '' ? fallback : Number(value)
		if (Number.isNaN(number) || !Number.isInteger(number) || number < 1) {
			throw new Error(`Invalid notation: ${notationText}`)
		}
		return number
	}

	notation.forEach(roll => {
		if (typeof roll === 'object') {
			if (!roll.sides) {
				throw new Error('Roll notation is missing sides')
			}
			parsedNotation.push({ qty: 1, modifier: 0, ...roll })
			return
		}

		const cleanNotation = String(roll).trim().replace(/\s+/g, '')
		const match = cleanNotation.match(percentNotation) || cleanNotation.match(diceNotation) || cleanNotation.match(fudgeNotation) || cleanNotation.match(customNotation)

		if (!match || match.length < 3) {
			throw new Error(`Invalid notation: ${roll}`)
		}

		let mod = 0
		if (match[3] && modifier.test(match[3])) {
			const modParts = match[3].match(modifier)
			mod = validNumber(modParts[2], 0, roll)
			if (modParts[1] === '-') {
				mod *= -1
			}
		}

		const returnObj = {
			qty: validNumber(match[1], 1, roll),
			modifier: mod,
			notation: cleanNotation,
		}

		if (cleanNotation.match(percentNotation)) {
			returnObj.sides = 'd100'
			returnObj.data = 'single'
		} else if (cleanNotation.match(fudgeNotation)) {
			returnObj.sides = 'fate'
		} else if (diceAvailable.includes(cleanNotation.match(customNotation)[2])) {
			returnObj.sides = match[2]
		} else {
			returnObj.sides = cleanNotation.match(diceNotation) ? `d${match[2]}` : match[2]
		}

		parsedNotation.push(returnObj)
	})

	return parsedNotation
}

const normalizeDieType = sides => Number.isInteger(sides) ? `d${sides}` : sides

const normalizeSides = sides => {
	if (sides === '100') {
		return { sides: 100, data: 'single' }
	}
	if (typeof sides === 'string' && /^d[1-9][0-9]{0,2}$/i.test(sides)) {
		return { sides: parseInt(sides.replace(/\D/g, ''), 10) }
	}
	return { sides }
}

const buildRollData = ({ parsedNotation, themeData, theme, themeColor, delay }) => {
	const groups = []
	const rolls = []
	const renderDice = []
	let groupIndex = 0
	let rollIndex = 0
	let idIndex = 0
	let collectionId = 0
	let newStartPoint = true
	let primaryIndex = 0
	const colorSuffix = getColorSuffix(themeData, themeColor)

	parsedNotation.forEach(notation => {
		const groupId = groupIndex++
		const normalized = normalizeSides(notation.sides)
		const sides = normalized.sides
		const data = notation.data || normalized.data
		const dieType = normalizeDieType(sides)

		if (!themeData.diceAvailable.includes(dieType)) {
			throw new Error(`${dieType} is not available in theme '${theme}'.`)
		}

		const group = {
			id: groupId,
			qty: notation.qty,
			sides,
			modifier: notation.modifier || 0,
			notation: notation.notation,
			rolls: [],
		}

		for (let i = 0; i < notation.qty; i++) {
			const rollId = rollIndex++
			const id = idIndex++
			const roll = {
				sides,
				data,
				dieType,
				groupId,
				collectionId,
				rollId,
				id,
				theme,
				themeColor,
				meshName: themeData.meshName,
			}
			rolls.push(roll)
			group.rolls.push(roll)

			renderDice.push({
				...roll,
				auxiliary: false,
				resultRollId: rollId,
				colorSuffix,
				delayMs: primaryIndex * delay,
				newStartPoint,
			})

			if (sides === 100 && data !== 'single') {
				renderDice.push({
					...roll,
					id: id + 10000,
					sides: 10,
					dieType: 'd10',
					auxiliary: true,
					auxiliaryType: 'd100-ones',
					resultRollId: rollId,
					colorSuffix,
					delayMs: primaryIndex * delay,
					newStartPoint: false,
				})
			}

			newStartPoint = false
			primaryIndex++
		}

		groups.push(group)
	})

	return { groups, rolls, renderDice }
}

const computeGravity = (gravity = defaultOptions.gravity, mass = defaultOptions.mass) => gravity === 0 ? 0 : gravity + mass / 3
const computeMass = (mass = defaultOptions.mass) => 1 + mass / 3
const computeSpin = (spin = defaultOptions.spinForce, spinScale = 40) => spin / spinScale
const computeThrowForce = (throwForce = defaultOptions.throwForce, mass = defaultOptions.mass, scale = defaultOptions.scale) => throwForce / 2 / mass * (1 + scale / 6)
const computeStartingHeight = (height = defaultOptions.startingHeight) => height < 1 ? 1 : height

const createPhysicsContext = ({ Ammo, themeData, options, random }) => {
	const config = {
		...options,
		gravity: computeGravity(options.gravity, options.mass),
		mass: computeMass(options.mass),
		spinForce: computeSpin(options.spinForce),
		throwForce: computeThrowForce(options.throwForce, options.mass, options.scale),
		startingHeight: computeStartingHeight(options.startingHeight),
	}
	const aspect = options.width / options.height
	const tmpBtTrans = new Ammo.btTransform()
	const colliders = {}
	const boxParts = []

	const vec = (x, y, z) => new Ammo.btVector3(x, y, z)

	const setStartPosition = () => {
		const edgeOffset = .5
		const xMin = config.size * aspect / 2 - edgeOffset
		const xMax = config.size * aspect / -2 + edgeOffset
		const yMin = config.size / 2 - edgeOffset
		const yMax = config.size / -2 + edgeOffset
		const xEnvelope = randomRange(random, xMin, xMax)
		const yEnvelope = randomRange(random, yMin, yMax)
		const tossFromTop = Math.round(random())
		const tossFromLeft = Math.round(random())
		const tossX = Math.round(random())

		config.startPosition = [
			tossX ? xEnvelope : tossFromLeft ? xMax : xMin,
			config.startingHeight,
			tossX ? tossFromTop ? yMax : yMin : yEnvelope,
		]
	}

	const createConvexHull = mesh => {
		const convexMesh = new Ammo.btConvexHullShape()
		for (let i = 0; i < mesh.positions.length; i += 3) {
			convexMesh.addPoint(vec(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]), true)
		}
		convexMesh.setLocalScaling(vec(mesh.scaling[0] * config.scale, mesh.scaling[1] * config.scale, mesh.scaling[2] * config.scale))
		return convexMesh
	}

	themeData.colliders.forEach(model => {
		colliders[`${themeData.meshName}_${model.name}`] = {
			...model,
			convexHull: createConvexHull(model),
		}
	})

	const createRigidBody = (collisionShape, params) => {
		const {
			mass = .1,
			collisionFlags = 0,
			pos = [0, 0, 0],
			quat = [
				randomRange(random, -1.5, 1.5),
				randomRange(random, -1.5, 1.5),
				randomRange(random, -1.5, 1.5),
				-1,
			],
			friction = config.friction,
			restitution = config.restitution,
		} = params

		const transform = new Ammo.btTransform()
		transform.setIdentity()
		transform.setOrigin(vec(pos[0], pos[1], pos[2]))
		transform.setRotation(new Ammo.btQuaternion(quat[0], quat[1], quat[2], quat[3]))

		const motionState = new Ammo.btDefaultMotionState(transform)
		const localInertia = vec(0, 0, 0)
		if (mass > 0) {
			collisionShape.calculateLocalInertia(mass, localInertia)
		}
		const rbInfo = new Ammo.btRigidBodyConstructionInfo(mass, motionState, collisionShape, localInertia)
		const rigidBody = new Ammo.btRigidBody(rbInfo)

		if (mass > 0) {
			rigidBody.setActivationState(4)
		}
		rigidBody.setCollisionFlags(collisionFlags)
		rigidBody.setFriction(friction)
		rigidBody.setRestitution(restitution)
		rigidBody.setDamping(config.linearDamping, config.angularDamping)

		return rigidBody
	}

	const setupPhysicsWorld = () => {
		const collisionConfiguration = new Ammo.btDefaultCollisionConfiguration()
		const broadphase = new Ammo.btDbvtBroadphase()
		const solver = new Ammo.btSequentialImpulseConstraintSolver()
		const dispatcher = new Ammo.btCollisionDispatcher(collisionConfiguration)
		const world = new Ammo.btDiscreteDynamicsWorld(dispatcher, broadphase, solver, collisionConfiguration)
		world.setGravity(vec(0, -9.81 * config.gravity, 0))
		return world
	}

	const physicsWorld = setupPhysicsWorld()

	const addBoxPart = (id, origin, shape) => {
		const localInertia = vec(0, 0, 0)
		const transform = new Ammo.btTransform()
		transform.setIdentity()
		transform.setOrigin(vec(origin[0], origin[1], origin[2]))
		const motionState = new Ammo.btDefaultMotionState(transform)
		const info = new Ammo.btRigidBodyConstructionInfo(0, motionState, shape, localInertia)
		const body = new Ammo.btRigidBody(info)
		body.id = id
		body.setFriction(config.friction)
		body.setRestitution(config.restitution)
		physicsWorld.addRigidBody(body)
		boxParts.push(body)
	}

	const addBoxToWorld = () => {
		const size = config.size
		const height = config.startingHeight + 10
		addBoxPart('box_bottom', [0, -.5, 0], new Ammo.btBoxShape(vec(size * aspect, 1, size)))
		addBoxPart('box_top', [0, height - .5, 0], new Ammo.btBoxShape(vec(size * aspect, 1, size)))
		addBoxPart('box_wall_north', [0, 0, (size / -2) - .5], new Ammo.btBoxShape(vec(size * aspect, height, 1)))
		addBoxPart('box_wall_south', [0, 0, (size / 2) + .5], new Ammo.btBoxShape(vec(size * aspect, height, 1)))
		addBoxPart('box_wall_east', [(size * aspect / -2) - .5, 0, 0], new Ammo.btBoxShape(vec(1, height, size)))
		addBoxPart('box_wall_west', [(size * aspect / 2) + .5, 0, 0], new Ammo.btBoxShape(vec(1, height, size)))
	}

	const rollDie = die => {
		die.setLinearVelocity(vec(
			randomRange(random, -config.startPosition[0] * .5, -config.startPosition[0] * config.throwForce),
			randomRange(random, -config.startPosition[1], -config.startPosition[1] * 2),
			randomRange(random, -config.startPosition[2] * .5, -config.startPosition[2] * config.throwForce),
		))

		const flippy = random() > .5 ? 1 : -1
		const spinny = randomRange(random, config.spinForce * .5, config.spinForce)
		const force = vec(spinny * flippy, spinny * -flippy, spinny * flippy)
		const scale = Math.abs(config.scale - 1) + config.scale * config.scale * (die.mass / config.mass) * .75
		die.applyImpulse(force, vec(scale, scale, scale))
	}

	const addDie = renderDie => {
		if (renderDie.newStartPoint) {
			setStartPosition()
		}
		const dieType = normalizeDieType(renderDie.sides)
		const collider = colliders[`${themeData.meshName}_${dieType}_collider`]
		if (!collider) {
			throw new Error(`No collider found for ${dieType}.`)
		}
		const colliderMass = collider.physicsMass || .1
		const mass = colliderMass * config.mass * config.scale
		const body = createRigidBody(collider.convexHull, {
			mass,
			pos: config.startPosition,
		})
		body.id = renderDie.id
		body.timeout = config.settleTimeout
		body.mass = mass
		physicsWorld.addRigidBody(body)
		rollDie(body)
		return body
	}

	const getTransform = body => {
		const motionState = body.getMotionState()
		if (!motionState) {
			return null
		}
		motionState.getWorldTransform(tmpBtTrans)
		const p = tmpBtTrans.getOrigin()
		const q = tmpBtTrans.getRotation()
		return {
			position: [p.x(), p.y(), p.z()],
			quaternion: [q.x(), q.y(), q.z(), q.w()],
		}
	}

	setStartPosition()
	addBoxToWorld()

	return {
		Ammo,
		config,
		physicsWorld,
		addDie,
		getTransform,
		vec,
	}
}

const normalizeQuaternion = q => {
	const length = Math.hypot(q[0], q[1], q[2], q[3]) || 1
	return [q[0] / length, q[1] / length, q[2] / length, q[3] / length]
}

const invertQuaternion = q => {
	const normalized = normalizeQuaternion(q)
	return [-normalized[0], -normalized[1], -normalized[2], normalized[3]]
}

const rotateVector = (v, q) => {
	const [x, y, z] = v
	const [qx, qy, qz, qw] = normalizeQuaternion(q)
	const tx = 2 * (qy * z - qz * y)
	const ty = 2 * (qz * x - qx * z)
	const tz = 2 * (qx * y - qy * x)

	return [
		x + qw * tx + (qy * tz - qz * ty),
		y + qw * ty + (qz * tx - qx * tz),
		z + qw * tz + (qx * ty - qy * tx),
	]
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

const intersectRayTriangle = (direction, v0, v1, v2) => {
	const epsilon = 1e-8
	const edge1 = sub(v1, v0)
	const edge2 = sub(v2, v0)
	const h = cross(direction, edge2)
	const a = dot(edge1, h)
	if (a > -epsilon && a < epsilon) {
		return null
	}
	const f = 1 / a
	const s = [-v0[0], -v0[1], -v0[2]]
	const u = f * dot(s, h)
	if (u < 0 || u > 1) {
		return null
	}
	const q = cross(s, edge1)
	const v = f * dot(direction, q)
	if (v < 0 || u + v > 1) {
		return null
	}
	const t = f * dot(edge2, q)
	return t > epsilon ? t : null
}

const resolveDieValue = ({ renderDie, state, themeData }) => {
	const collider = themeData.colliders.find(model => model.name === `${renderDie.dieType}_collider`)
	const faceMap = themeData.colliderFaceMap[renderDie.dieType]
	if (!collider || !faceMap) {
		throw new Error(`No face map found for ${renderDie.dieType}.`)
	}

	const worldDirection = renderDie.dieType === 'd4' && themeData.d4FaceDown ? [0, -1, 0] : [0, 1, 0]
	const localDirection = rotateVector(worldDirection, invertQuaternion(state.quaternion))
	let nearest = Infinity
	let faceId = null

	for (let i = 0; i < collider.indices.length; i += 3) {
		const indices = [collider.indices[i], collider.indices[i + 1], collider.indices[i + 2]]
		const vertices = indices.map(index => {
			const offset = index * 3
			return [
				collider.positions[offset],
				collider.positions[offset + 1],
				collider.positions[offset + 2],
			]
		})
		const hit = intersectRayTriangle(localDirection, vertices[0], vertices[1], vertices[2])
		if (hit !== null && hit < nearest) {
			nearest = hit
			faceId = i / 3
		}
	}

	if (faceId === null || faceMap[faceId] === undefined) {
		throw new Error(`Unable to resolve ${renderDie.dieType} result from final frame.`)
	}

	return faceMap[faceId]
}

const encodeFrames = frameData => Buffer.from(frameData.buffer, frameData.byteOffset, frameData.byteLength).toString('base64')

export const simulateRoll = async ({
	notation,
	theme = defaultOptions.theme,
	themeColor = defaultOptions.themeColor,
	seed,
	assetRoot = defaultAssetRoot,
	...incomingOptions
}) => {
	if (!notation || (Array.isArray(notation) && notation.length === 0)) {
		const error = new Error('Missing required roll notation. Use ?notation=2d20 or ?dice=2d6.')
		error.statusCode = 400
		throw error
	}

	const cleanIncomingOptions = Object.fromEntries(Object.entries(incomingOptions).filter(([, value]) => value !== undefined))
	const options = {
		...defaultOptions,
		...cleanIncomingOptions,
		theme,
		themeColor,
	}
	options.maxDurationMs = Math.max(1000, Math.min(Number(options.maxDurationMs) || defaultOptions.maxDurationMs, 30000))

	const random = seed === undefined || seed === null || seed === '' ? Math.random : seededRandom(seed)
	const [Ammo, themeData] = await Promise.all([
		getAmmo(assetRoot),
		loadThemeData({ theme, assetRoot }),
	])
	const parsedNotation = parseRollNotation(notation, themeData.diceAvailable)
	const { groups, rolls, renderDice } = buildRollData({ parsedNotation, themeData, theme, themeColor, delay: options.delay })
	const physics = createPhysicsContext({ Ammo, themeData, options, random })
	const stateById = new Map(renderDice.map(die => [
		die.id,
		{
			id: die.id,
			position: [0, -100, 0],
			quaternion: [0, 0, 0, 1],
			body: null,
			asleep: false,
		},
	]))
	const scheduledDice = [...renderDice].sort((a, b) => a.delayMs - b.delayMs)
	const activeBodies = []
	const sleepingBodies = []
	const floats = []
	const frameStride = 8
	const dt = 1000 / options.frameRate
	const maxFrames = Math.ceil(options.maxDurationMs / dt)

	const pushFrame = () => {
		renderDice.forEach(die => {
			const state = stateById.get(die.id)
			floats.push(
				die.id,
				state.position[0],
				state.position[1],
				state.position[2],
				state.quaternion[0],
				state.quaternion[1],
				state.quaternion[2],
				state.quaternion[3],
			)
		})
	}

	let elapsed = 0
	let timedOut = false
	for (let frame = 0; frame < maxFrames; frame++) {
		while (scheduledDice.length && scheduledDice[0].delayMs <= elapsed) {
			const renderDie = scheduledDice.shift()
			const body = physics.addDie(renderDie)
			const state = stateById.get(renderDie.id)
			state.body = body
			activeBodies.push(body)
		}

		physics.physicsWorld.stepSimulation(dt / 1000, 2, 1 / 90)

		for (let i = activeBodies.length - 1; i >= 0; i--) {
			const body = activeBodies[i]
			const transform = physics.getTransform(body)
			const state = stateById.get(body.id)
			if (transform) {
				state.position = transform.position
				state.quaternion = transform.quaternion
			}

			const speed = body.getLinearVelocity().length()
			const tilt = body.getAngularVelocity().length()
			if ((speed < .01 && tilt < .005) || body.timeout < 0) {
				state.asleep = true
				body.asleep = true
				body.setMassProps(0, physics.vec(0, 0, 0))
				body.forceActivationState(3)
				body.setLinearVelocity(physics.vec(0, 0, 0))
				body.setAngularVelocity(physics.vec(0, 0, 0))
				sleepingBodies.push(activeBodies.splice(i, 1)[0])
			} else {
				body.timeout -= dt
			}
		}

		pushFrame()

		if (!scheduledDice.length && activeBodies.length === 0 && sleepingBodies.length === renderDice.length) {
			break
		}
		elapsed += dt
		if (frame === maxFrames - 1) {
			timedOut = true
		}
	}

	const valueByRenderId = new Map()
	renderDice.forEach(renderDie => {
		const state = stateById.get(renderDie.id)
		valueByRenderId.set(renderDie.id, resolveDieValue({ renderDie, state, themeData }))
	})

	const rollResults = rolls.map(roll => {
		let value = valueByRenderId.get(roll.id)
		if (roll.sides === 100 && roll.data !== 'single') {
			value += valueByRenderId.get(roll.id + 10000)
		}
		return {
			...roll,
			value,
		}
	})

	const results = groups.map(group => {
		const groupRolls = rollResults.filter(roll => roll.groupId === group.id)
		const value = groupRolls.reduce((total, roll) => total + roll.value, 0) + group.modifier
		return {
			id: group.id,
			qty: groupRolls.length,
			sides: group.sides,
			modifier: group.modifier,
			notation: group.notation,
			value,
			rolls: groupRolls.map(({ collectionId, id, meshName, ...roll }) => roll),
		}
	})

	const frameData = new Float32Array(floats)
	const frameCount = frameData.length / (renderDice.length * frameStride)

	return {
		version: 1,
		metadata: {
			notation: Array.isArray(notation) ? notation : String(notation),
			generatedAt: new Date().toISOString(),
			seed: seed === undefined || seed === null || seed === '' ? null : String(seed),
			theme,
			themeColor,
			timedOut,
			config: {
				width: options.width,
				height: options.height,
				scale: options.scale,
				frameRate: options.frameRate,
				delay: options.delay,
				settleTimeout: options.settleTimeout,
			},
			results,
			rolls: rollResults,
			renderDice: renderDice.map(({ delayMs, newStartPoint, ...die }) => die),
			frame: {
				type: 'Float32Array',
				fields: ['id', 'px', 'py', 'pz', 'qx', 'qy', 'qz', 'qw'],
				stride: frameStride,
				dieCount: renderDice.length,
				frameCount,
				frameRate: options.frameRate,
				length: frameData.length,
				durationMs: Math.round(frameCount * dt),
			},
		},
		frames: {
			type: 'Float32Array',
			encoding: 'base64',
			littleEndian: true,
			length: frameData.length,
			data: encodeFrames(frameData),
		},
	}
}

export const defaultRollAssetRoot = defaultAssetRoot
