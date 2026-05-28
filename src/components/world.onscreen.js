import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { createEngine } from './world/engine'
import { createScene } from './world/scene'
import { createCamera } from './world/camera'
import { createLights } from './world/lights'
import Container from './Container'
import Dice from './Dice'
import ThemeLoader from './ThemeLoader'

const requestReplayFrame = callback => {
	if (typeof requestAnimationFrame === 'function') {
		return requestAnimationFrame(callback)
	}
	return setTimeout(() => callback(typeof performance !== 'undefined' ? performance.now() : Date.now()), 16)
}

const cancelReplayFrame = frameId => {
	if (typeof cancelAnimationFrame === 'function') {
		cancelAnimationFrame(frameId)
	} else {
		clearTimeout(frameId)
	}
}

class WorldOnscreen {
	config
	initialized = false
	#dieCache = {}
	#count = 0
	#sleeperCount = 0
	#dieRollTimer = []
	#canvas
	#engine
	#scene
	#camera
	#lights
	#container
	#themeLoader
	#physicsWorkerPort
	#meshList = {}
	#replayFrameRequest = null
	#recording = null
	noop = () => {}
	diceBufferView = new Float32Array(8000)

	constructor(options){
		this.onInitComplete = options.onInitComplete || this.noop
		this.onThemeLoaded = options.onThemeLoaded || this.noop
		this.onRollResult = options.onRollResult || this.noop
		this.onRollComplete = options.onRollComplete || this.noop
		this.onDieRemoved = options.onDieRemoved || this.noop
		this.initialized = this.initScene(options)
	}
	
	// initialize the babylon scene
	async initScene(config) {
		this.#canvas  = config.canvas
		this.#canvas.width = config.width
		this.#canvas.height = config.height
	
		// set the config from World
		this.config = config.options
	
		// setup babylonJS scene
		this.#engine  = createEngine(this.#canvas )
		this.#scene = createScene({engine:this.#engine })
		this.#camera  = createCamera({engine:this.#engine, scene: this.#scene})
		this.#lights  = createLights({
			enableShadows: this.config.enableShadows,
			shadowTransparency: this.config.shadowTransparency,
			intensity: this.config.lightIntensity,
			scene: this.#scene
		})
	
		// create the box that provides surfaces for shadows to render on
		this.#container  = new Container({
			enableShadows: this.config.enableShadows,
			aspect: this.#canvas.width / this.#canvas.height,
			lights: this.#lights,
			scene: this.#scene
		})
		
		this.#themeLoader = new ThemeLoader({scene: this.#scene})

		// init complete - let the world know
		this.onInitComplete()
	}

	connect(port){
		this.#physicsWorkerPort = port

		this.#physicsWorkerPort.postMessage({
			action: "initBuffer",
			diceBuffer: this.diceBufferView.buffer
		}, [this.diceBufferView.buffer])

		this.#physicsWorkerPort.onmessage = (e) => {
			switch (e.data.action) {
				case "updates": // dice status/position updates from physics worker
					this.updatesFromPhysics(e.data.diceBuffer)
					break;
			
				default:
					console.error("action from physicsWorker not found in offscreen worker")
					break;
			}
		}
	}

	updateConfig(options){
		const prevConfig = this.config
		this.config = options
		// check if shadows setting has changed
		if(prevConfig.enableShadows !== this.config.enableShadows) {
			// regenerate the lights
			Object.values(this.#lights ).forEach(light => light.dispose())
			this.#lights = createLights(
				{
					enableShadows: this.config.enableShadows,
					shadowTransparency: this.config.shadowTransparency,
					intensity: this.config.lightIntensity,
					scene: this.#scene
				}
			)
		}
		if(prevConfig.scale !== this.config.scale) {
			Object.values(this.#dieCache).forEach(({mesh}) => {
				if(mesh){
					const {x = 1,y = 1,z = 1} = mesh?.metadata?.baseScale
					mesh.scaling = new Vector3(
						this.config.scale * x,
						this.config.scale * y,
						this.config.scale * z
					)
				}
			})
		}
		if(prevConfig.shadowTransparency !== this.config.shadowTransparency) {
			this.#lights.directional.shadowGenerator.darkness = this.config.shadowTransparency
		}
		if(prevConfig.lightIntensity !== this.config.lightIntensity) {
			this.#lights.directional.intensity = .65 * this.config.lightIntensity
			this.#lights.hemispheric.intensity = .4 * this.config.lightIntensity
		}
	}

	// all this does is start the render engine.
	render(newStartPoint) {
		// document.body.addEventListener('click',()=>engine.stopRenderLoop())
		this.#engine.runRenderLoop(this.renderLoop.bind(this))
		this.#physicsWorkerPort.postMessage({
			action: "resumeSimulation",
			newStartPoint
		})
	}

	renderLoop() {
		// if no dice are awake then stop the render loop and save some CPU power
		if(this.#sleeperCount && this.#sleeperCount === Object.keys(this.#dieCache).length) {
			// console.log(`no dice moving`)
			this.#engine.stopRenderLoop()

			// stop the physics engine
			this.#physicsWorkerPort.postMessage({
				action: "stopSimulation",
			})

			// trigger callback that roll is complete
			this.onRollComplete()
		}
		// otherwise keep on rendering
		else {
			this.#scene.render() // not the same as this.render()
		}
	}

	async loadTheme(options) {
		// await loadTheme(theme, this.config.origin + this.config.assetPath, this.#scene)
		const {theme, basePath, material, meshFilePath, meshName} = options
		// load the textures and create the materials needed for this theme
		await this.#themeLoader.load({theme,basePath,material})
	
		// Load the 3D meshes declared by the theme and return the collider mesh data to be passed on to the physics worker
		// don't load same models twice
		if(!Object.keys(this.#meshList).includes(meshName)){
			this.#meshList[meshName] = meshFilePath
			const colliders = await Dice.loadModels({meshFilePath,meshName}, this.#scene)

			if(!colliders){
				throw new Error("No colliders returned from the 3D mesh file. Low poly colliders are expected to be in the same file as the high poly dice and the mesh name contains the word 'collider'")
			}
		
			this.#physicsWorkerPort.postMessage({
				action: "loadModels",
				options: {
					colliders,
					meshName
				}
			})
		}

		this.onThemeLoaded({id: theme})
	}

	clear() {
		if(this.#replayFrameRequest !== null) {
			cancelReplayFrame(this.#replayFrameRequest)
			this.#replayFrameRequest = null
		}
		if(!Object.keys(this.#dieCache).length && !this.#sleeperCount) {
			return
		}
		if(this.diceBufferView.byteLength){
			this.diceBufferView.fill(0)
		}
		this.#dieRollTimer.forEach(timer=>clearTimeout(timer))
		// stop anything that's currently rendering
		this.#engine.stopRenderLoop()
		// remove all dice
		Object.values(this.#dieCache).forEach(die => {
			if(die.mesh)
				die.mesh.dispose()
		})
		
		// reset storage
		this.#dieCache = {}
		this.#count = 0
		this.#sleeperCount = 0

		// step the animation forward
		this.#scene.render()
	}

	#rememberRecordingDie(die) {
		if(!this.#recording || !die?.config || this.#recording.renderDice.has(die.id)) {
			return
		}

		const {assetPath, enableShadows, lights, scale, ...config} = die.config
		this.#recording.renderDice.set(die.id, {
			...config,
			id: die.id,
			auxiliary: !!die.dieParent,
			auxiliaryType: die.dieParent ? 'd100-ones' : undefined,
			resultRollId: config.rollId,
		})
	}

	#dieRecordingState(die) {
		if(!die?.mesh) {
			return [
				die.id,
				0,
				-100,
				0,
				0,
				0,
				0,
				1,
			]
		}

		const position = die.mesh.position
		const quaternion = die.mesh.rotationQuaternion
		return [
			die.id,
			position.x,
			position.y,
			position.z,
			quaternion?.x || 0,
			quaternion?.y || 0,
			quaternion?.z || 0,
			quaternion?.w || 1,
		]
	}

	#recordFrame() {
		if(!this.#recording) {
			return
		}

		const rows = new Map()
		Object.values(this.#dieCache).forEach(die => {
			this.#rememberRecordingDie(die)
			rows.set(die.id, this.#dieRecordingState(die))
		})

		if(rows.size) {
			this.#recording.frames.push(rows)
		}
	}

	startRecording({frameRate = 60} = {}) {
		this.#recording = {
			frameRate,
			frames: [],
			renderDice: new Map(),
		}
	}

	stopRecording() {
		if(!this.#recording) {
			return {
				frameData: new Float32Array(),
				frameRate: 60,
				renderDice: [],
			}
		}

		this.#recordFrame()

		const recording = this.#recording
		this.#recording = null
		const renderDice = Array.from(recording.renderDice.values())
		const lastState = new Map()
		const floats = []

		recording.frames.forEach(frame => {
			renderDice.forEach(die => {
				const state = frame.get(die.id) || lastState.get(die.id) || [
					die.id,
					0,
					-100,
					0,
					0,
					0,
					0,
					1,
				]
				lastState.set(die.id, state)
				floats.push(...state)
			})
		})

		return {
			frameData: new Float32Array(floats),
			frameRate: recording.frameRate,
			renderDice,
		}
	}

	async replay({metadata, frameData, speed = 1}) {
		this.clear()
		this.#engine.stopRenderLoop()

		const renderDice = metadata.renderDice || []
		const frameMeta = metadata.frame || {}
		const stride = frameMeta.stride || 8
		const dieCount = frameMeta.dieCount || renderDice.length
		const frameCount = frameMeta.frameCount || Math.floor(frameData.length / (dieCount * stride))
		const frameRate = frameMeta.frameRate || 60
		const playbackSpeed = Math.max(Number(speed) || 1, .05)
		const frameDuration = 1000 / frameRate / playbackSpeed

		await Promise.all(renderDice.map(async die => {
			const diceOptions = {
				...die,
				assetPath: this.config.assetPath,
				enableShadows: this.config.enableShadows,
				scale: this.config.scale,
				lights: this.#lights,
				colorSuffix: die.colorSuffix || '',
				themeColor: die.themeColor || metadata.themeColor || this.config.themeColor,
				theme: die.theme || metadata.theme || this.config.theme,
				meshName: die.meshName,
			}
			await Dice.loadDie(diceOptions, this.#scene)
			const newDie = new Dice(diceOptions, this.#scene)
			this.#dieCache[newDie.id] = newDie
		}))

		const applyFrame = frameIndex => {
			const frameOffset = frameIndex * dieCount * stride
			for (let i = 0; i < dieCount; i++) {
				const offset = frameOffset + i * stride
				const id = frameData[offset]
				const die = this.#dieCache[`${id}`]
				if(!die?.mesh) {
					continue
				}
				die.mesh.position.set(
					frameData[offset + 1],
					frameData[offset + 2],
					frameData[offset + 3]
				)
				die.mesh.rotationQuaternion.set(
					frameData[offset + 4],
					frameData[offset + 5],
					frameData[offset + 6],
					frameData[offset + 7]
				)
			}
			this.#scene.render()
		}

		if(!frameCount) {
			return metadata.results
		}

		return new Promise(resolve => {
			let startTime
			let lastFrame = -1
			const animate = now => {
				if(startTime === undefined) {
					startTime = now
				}
				const frameIndex = Math.min(Math.floor((now - startTime) / frameDuration), frameCount - 1)
				if(frameIndex !== lastFrame) {
					applyFrame(frameIndex)
					lastFrame = frameIndex
				}
				if(frameIndex >= frameCount - 1) {
					this.#replayFrameRequest = null
					resolve(metadata.results)
					return
				}
				this.#replayFrameRequest = requestReplayFrame(animate)
			}

			applyFrame(0)
			this.#replayFrameRequest = requestReplayFrame(animate)
		})
	}

	add(options) {
		// loadDie allows you to specify sides(dieType) and theme and returns the options you passed in
		Dice.loadDie(options, this.#scene).then(resp => {
			// space out adding the dice so they don't lump together too much
			this.#dieRollTimer.push(setTimeout(() => {
				this.#add(resp)
			}, this.#count++ * this.config.delay))
		})
	}

	addNonDie(die){
		if(this.#engine.activeRenderLoops.length === 0) {
			this.render(false)
		}
		const {id, value, ...rest} = die
		const newDie = {
			id,
			value,
			config: rest
		}
		this.#dieCache[id] = newDie
		this.#rememberRecordingDie(newDie)
		
		// double timeout to ensure any real dice have a chance to queue up and rollResults isn't triggered right away
		setTimeout(()=>{
			this.#dieRollTimer.push(setTimeout(() => {
				this.handleAsleep(newDie)
			}, this.#count++ * this.config.delay))
		}, 10)
	}

	// add a die to the scene
	async #add(options) {
		if(this.#engine.activeRenderLoops.length === 0) {
			this.render(options.newStartPoint)
		}
		const diceOptions = {
			...options,
			assetPath: this.config.assetPath,
			enableShadows: this.config.enableShadows,
			scale: this.config.scale,
			lights: this.#lights,
		}
		
		const newDie = new Dice(diceOptions, this.#scene)
		
		// save the die just created to the cache
		this.#dieCache[newDie.id] = newDie
		this.#rememberRecordingDie(newDie)
		
		// tell the physics engine to roll this die type - which is a low poly collider
		this.#physicsWorkerPort.postMessage({
			action: "addDie",
			options: {
				sides: options.sides,
				scale: this.config.scale,
				id: newDie.id,
				newStartPoint: options.newStartPoint,
				theme: options.theme,
				meshName: options.meshName,
			}
		})
	
		// for d100's we need to add an additional d10 and pair it up with the d100 just created
		if(options.sides === 100 && options.data !== 'single') {
			// assign the new die to a property on the d100 - spread the options in order to pass a matching theme
			newDie.d10Instance = await Dice.loadDie({...diceOptions, dieType: 'd10', sides: 10, id: newDie.id + 10000}, this.#scene).then( response =>  {
				const d10Instance = new Dice(response, this.#scene)
				// identify the parent of this d10 so we can calculate the roll result later
				d10Instance.dieParent = newDie
				return d10Instance
			})
			// add the d10 to the cache and ask the physics worker for a collider
			this.#dieCache[`${newDie.d10Instance.id}`] = newDie.d10Instance
			this.#rememberRecordingDie(newDie.d10Instance)
			this.#physicsWorkerPort.postMessage({
				action: "addDie",
				options: {
					sides: 10,
					scale: this.config.scale,
					id: newDie.d10Instance.id,
					theme: options.theme,
					meshName: options.meshName
				}
			})
		}
	
		// return the die instance
		return newDie
	
	}
	
	remove(data) {
	// TODO: test this with exploding dice
	const dieData = this.#dieCache[data.id]
	
	// check if this is d100 and remove associated d10 first
	if(dieData.hasOwnProperty('d10Instance')){
		// remove die
		if(this.#dieCache[dieData.d10Instance.id].mesh){
			this.#dieCache[dieData.d10Instance.id].mesh.dispose()

			// remove d10 physics body just for d100 items
			this.#physicsWorkerPort.postMessage({
				action: "removeDie",
				id: dieData.d10Instance.id
			})
		}
		// delete entry
		delete this.#dieCache[dieData.d10Instance.id]
		// decrement count
		this.#sleeperCount--
	}

	// remove die
	if(this.#dieCache[data.id].mesh){
		this.#dieCache[data.id].mesh.dispose()
	}
	// delete entry
	delete this.#dieCache[data.id]
	// decrement count
	this.#sleeperCount--

	// step the animation forward
	this.#scene.render()

	this.onDieRemoved(data.rollId)
}
	
	updatesFromPhysics(buffer) {
		this.diceBufferView = new Float32Array(buffer)
		let bufferIndex = 1

		// loop will be based on diceBufferView[0] value which is the bodies length in physics.worker
	for (let i = 0, len = this.diceBufferView[0]; i < len; i++) {
		if(!Object.keys(this.#dieCache).length){
			continue
		}
		const die = this.#dieCache[`${this.diceBufferView[bufferIndex]}`]
		if(!die) {
			console.log("Error: die not available in scene to animate")
			break
		}
		// if the first position index is -1 then this die has been flagged as asleep
		if(this.diceBufferView[bufferIndex + 1] === -1) {
			this.handleAsleep(die)
		} else {
			const px = this.diceBufferView[bufferIndex + 1]
			const py = this.diceBufferView[bufferIndex + 2]
			const pz = this.diceBufferView[bufferIndex + 3]
			const qx = this.diceBufferView[bufferIndex + 4]
			const qy = this.diceBufferView[bufferIndex + 5]
			const qz = this.diceBufferView[bufferIndex + 6]
			const qw = this.diceBufferView[bufferIndex + 7]

			die.mesh.position.set(px, py, pz)
			die.mesh.rotationQuaternion.set(qx, qy, qz, qw)
		}

		bufferIndex = bufferIndex + 8
	}

	this.#recordFrame()

	// transfer the buffer back to physics worker
	requestAnimationFrame(()=>{
		this.#physicsWorkerPort.postMessage({
			action: "stepSimulation",
			diceBuffer: this.diceBufferView.buffer
		}, [this.diceBufferView.buffer])
	})
	}
	
	// handle the position updates from the physics worker. It's a simple flat array of numbers for quick and easy transfer
	async handleAsleep(die){
		// mark this die as asleep
		die.asleep = true
	
		// get the roll result for this die
		await Dice.getRollResult(die, this.#scene)
	
		if(die.d10Instance || die.dieParent) {
			// if one of the pair is asleep and the other isn't then it falls through without getting the roll result
			// otherwise both dice in the d100 are asleep and ready to calc their roll result
			if(die?.d10Instance?.asleep || die?.dieParent?.asleep) {
				const d100 = die.config.sides === 100 ? die : die.dieParent
				const d10 = die.config.sides === 10 ? die : die.d10Instance
				if(d100.rawValue){
					// this die is being processed again for some reason, probably a physics ineration that woke it before it was immobilized
					d100.value = d100.rawValue
				}
				// save the original value
				d100.rawValue = d100.value

				d100.value = d100.value + d10.value
	
				this.onRollResult({
					rollId: d100.config.rollId,
					value : d100.value
				})
			}
		} else {
			// turn 0's on a d10 into a 10
			if(die.config.sides === 10 && die.value === 0) {
				die.value = 10
			}
			this.onRollResult({
				rollId: die.config.rollId,
				value: die.value
			})
		}
		// add to the sleeper count
		this.#sleeperCount++
	}
	
	resize(options) {
		// redraw the dicebox
		const width = this.#canvas.width = options.width
		const height = this.#canvas.height = options.height
		this.#container.create({aspect: width / height})
		this.#engine.resize()
	}
}

export default WorldOnscreen
