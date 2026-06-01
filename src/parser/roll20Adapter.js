import * as diceRollerParserNamespace from '@3d-dice/dice-roller-parser'

const diceRollerParser = diceRollerParserNamespace.default || diceRollerParserNamespace
const { DiceRoller } = diceRollerParser

export const defaultRoll20ParserOptions = {
	maxNotationLength: 200,
	maxDiceCount: 100,
	maxSides: 100,
	maxRerollDepth: 100,
}

const rerollingModTypes = new Set(['explode', 'compound', 'penetrate', 'reroll', 'rerollOnce'])

export class RollNotationError extends Error {
	constructor(message, statusCode = 400) {
		super(message)
		this.name = 'RollNotationError'
		this.statusCode = statusCode
	}
}

const notationError = message => new RollNotationError(message)

const toOptions = options => ({
	...defaultRoll20ParserOptions,
	...options,
})

const cloneForMetadata = value => {
	if (value === undefined) {
		return undefined
	}
	return JSON.parse(JSON.stringify(value))
}

const normalizeNotationForParser = notation => notation
	.replace(/d00(?!\d)/gi, 'd100')
	.replace(/dFATE\b/gi, 'dF')

const getNotationText = notation => {
	if (typeof notation !== 'string') {
		throw notationError('Roll notation must be a string.')
	}
	const text = notation.trim()
	if (!text) {
		throw notationError('Roll notation cannot be empty.')
	}
	return text
}

export const rejectUnresolvedAppTokens = notation => {
	const match = notation.match(/@[A-Za-z_][\w.]*/u) || notation.match(/@/u)
	if (match) {
		throw notationError(`Unsupported roll notation contains unresolved app token '${match[0]}'. Resolve app tokens before rolling.`)
	}
}

const ensureNotationLength = (notation, options) => {
	if (notation.length > options.maxNotationLength) {
		throw notationError(`Roll notation is too long. Maximum length is ${options.maxNotationLength} characters.`)
	}
}

const isObject = value => value !== null && typeof value === 'object'

const hasNonEmptyLabel = node => {
	if (!isObject(node)) {
		return false
	}
	if (typeof node.label === 'string' && node.label.trim()) {
		return true
	}
	return Object.values(node).some(value => {
		if (Array.isArray(value)) {
			return value.some(hasNonEmptyLabel)
		}
		return hasNonEmptyLabel(value)
	})
}

export const hasRerollingMods = node => {
	if (!isObject(node)) {
		return false
	}
	if (rerollingModTypes.has(node.type)) {
		return true
	}
	return Object.values(node).some(value => {
		if (Array.isArray(value)) {
			return value.some(hasRerollingMods)
		}
		return hasRerollingMods(value)
	})
}

const hasDice = node => {
	if (!isObject(node)) {
		return false
	}
	if (node.type === 'die') {
		return true
	}
	return Object.values(node).some(value => {
		if (Array.isArray(value)) {
			return value.some(hasDice)
		}
		return hasDice(value)
	})
}

const evaluateStaticNumber = (node, context) => {
	if (!isObject(node)) {
		throw notationError(`Unsupported ${context}.`)
	}

	switch (node.type) {
		case 'number':
			return Number(node.value)
		case 'expression': {
			let value = evaluateStaticNumber(node.head, context)
			for (const op of node.ops || []) {
				const tail = evaluateStaticNumber(op.tail, context)
				switch (op.op) {
					case '+':
						value += tail
						break
					case '-':
						value -= tail
						break
					case '*':
						value *= tail
						break
					case '/':
						value /= tail
						break
					case '%':
						value %= tail
						break
					case '**':
						value **= tail
						break
					default:
						throw notationError(`Unsupported ${context} math operator '${op.op}'.`)
				}
			}
			return value
		}
		case 'mathfunction': {
			const value = evaluateStaticNumber(node.expr, context)
			switch (node.op) {
				case 'floor':
					return Math.floor(value)
				case 'ceil':
					return Math.ceil(value)
				case 'round':
					return Math.round(value)
				case 'abs':
					return Math.abs(value)
				default:
					throw notationError(`Unsupported ${context} math function '${node.op}'.`)
			}
		}
		default:
			throw notationError(`Unsupported ${context}. Dice count and sides must be static numbers.`)
	}
}

const ensurePositiveInteger = (value, context) => {
	if (!Number.isInteger(value) || value < 1) {
		throw notationError(`Invalid ${context}. Expected a positive integer.`)
	}
	return value
}

const normalizeSides = (die, options) => {
	if (die?.type === 'fate') {
		return 'fate'
	}
	const sides = ensurePositiveInteger(evaluateStaticNumber(die, 'die sides'), 'die sides')
	if (sides < 2) {
		throw notationError('Invalid die sides. Dice must have at least 2 sides.')
	}
	if (sides > options.maxSides) {
		throw notationError(`Roll notation exceeds the maximum die size of d${options.maxSides}.`)
	}
	return sides
}

const dieGroupNotation = (qty, sides) => `${qty}d${sides === 'fate' ? 'F' : sides}`

const createDiceGroup = (node, options, path) => {
	const qty = ensurePositiveInteger(evaluateStaticNumber(node.count, 'dice count'), 'dice count')
	const sides = normalizeSides(node.die, options)
	return {
		qty,
		sides: sides === 'fate' ? 'fate' : `d${sides}`,
		modifier: 0,
		notation: dieGroupNotation(qty, sides),
		data: undefined,
		parserPath: path,
	}
}

const appendDiceGroups = (node, groups, options, path = 'root') => {
	if (!isObject(node)) {
		return
	}

	switch (node.type) {
		case 'die':
			groups.push(createDiceGroup(node, options, path))
			for (const mod of [...(node.mods || []), ...(node.targets || [])]) {
				if (mod.expr && hasDice(mod.expr)) {
					throw notationError('Unsupported roll notation. Modifier expressions cannot require additional physical dice.')
				}
				if (mod.target?.value && hasDice(mod.target.value)) {
					throw notationError('Unsupported roll notation. Reroll target expressions cannot require additional physical dice.')
				}
			}
			if (node.match?.expr && hasDice(node.match.expr)) {
				throw notationError('Unsupported roll notation. Match expressions cannot require additional physical dice.')
			}
			break
		case 'diceExpression':
		case 'expression':
			appendDiceGroups(node.head, groups, options, `${path}.head`)
			for (let i = 0; i < (node.ops || []).length; i++) {
				appendDiceGroups(node.ops[i].tail, groups, options, `${path}.ops.${i}`)
			}
			break
		case 'group':
			for (let i = 0; i < (node.rolls || []).length; i++) {
				appendDiceGroups(node.rolls[i], groups, options, `${path}.rolls.${i}`)
			}
			for (const mod of node.mods || []) {
				if (mod.expr && hasDice(mod.expr)) {
					throw notationError('Unsupported roll notation. Group modifier expressions cannot require additional physical dice.')
				}
			}
			break
		case 'mathfunction':
			appendDiceGroups(node.expr, groups, options, `${path}.expr`)
			break
		case 'inline':
			appendDiceGroups(node.expr, groups, options, `${path}.expr`)
			break
		case 'number':
			break
		default:
			throw notationError(`Unsupported roll notation node '${node.type}'.`)
	}
}

const countDice = groups => groups.reduce((total, group) => total + group.qty, 0)

const getSingleGroupConstantModifier = node => {
	if (node?.type !== 'expression' || hasDice({ ...node, head: undefined })) {
		return 0
	}
	if (!hasDice(node.head)) {
		return 0
	}
	let modifier = 0
	for (const op of node.ops || []) {
		if (op.tail?.type !== 'number' || !['+', '-'].includes(op.op)) {
			return 0
		}
		modifier += op.op === '+' ? Number(op.tail.value) : -Number(op.tail.value)
	}
	return modifier
}

const maybeApplyLegacySingleModifier = (groups, parsedTree, originalNotation) => {
	if (groups.length !== 1) {
		return groups
	}
	const modifier = getSingleGroupConstantModifier(parsedTree)
	if (!modifier) {
		return groups
	}
	return [{
		...groups[0],
		modifier,
		notation: originalNotation.replace(/\s+/g, ''),
	}]
}

const maybeApplyPercentileSingleDie = (groups, originalNotation) => {
	let percentileCount = (originalNotation.match(/[dD](?:00|%)(?!\d)/g) || []).length
	if (!percentileCount) {
		return groups
	}
	return groups.map(group => {
		if (percentileCount > 0 && group.sides === 'd100') {
			percentileCount--
			return { ...group, data: 'single' }
		}
		return group
	})
}

const validateDiceGroups = (groups, options) => {
	const totalDice = countDice(groups)
	if (totalDice < 1) {
		throw notationError('Roll notation must include at least one physical die.')
	}
	if (totalDice > options.maxDiceCount) {
		throw notationError(`Roll notation requests ${totalDice} dice. Maximum dice count is ${options.maxDiceCount}.`)
	}
	groups.forEach(group => {
		ensurePositiveInteger(Number(group.qty), 'dice count')
		const sides = group.sides
		if (sides === 'fate') {
			return
		}
		const numericText = String(sides).replace(/\D/g, '')
		if (!Number.isInteger(sides) && !numericText && typeof sides === 'string') {
			return
		}
		const numericSides = Number.isInteger(sides)
			? sides
			: parseInt(numericText, 10)
		if (!Number.isInteger(numericSides) || numericSides < 2) {
			throw notationError('Invalid die sides. Dice must have at least 2 sides.')
		}
		if (numericSides > options.maxSides) {
			throw notationError(`Roll notation exceeds the maximum die size of d${options.maxSides}.`)
		}
	})
	return groups
}

export const parseAdvancedNotation = (notation, options = {}) => {
	const parserOptions = toOptions(options)
	const originalNotation = getNotationText(notation)

	ensureNotationLength(originalNotation, parserOptions)
	rejectUnresolvedAppTokens(originalNotation)

	const parserNotation = normalizeNotationForParser(originalNotation)
	const roller = new DiceRoller(null, parserOptions.maxRerollDepth)
	let parsedTree
	try {
		parsedTree = roller.parse(parserNotation)
	} catch (error) {
		throw notationError(`Invalid roll notation '${originalNotation}': ${error.message}`)
	}

	if (hasNonEmptyLabel(parsedTree)) {
		throw notationError(`Unsupported roll notation '${originalNotation}': unexpected trailing text '${parsedTree.label.trim()}'.`)
	}
	if (hasRerollingMods(parsedTree) && !parserOptions.allowRerollingMods) {
		throw notationError(`Reroll/explode notation is not yet supported in the replay API. Maximum configured reroll/explode depth is ${parserOptions.maxRerollDepth}.`)
	}

	const diceGroups = []
	appendDiceGroups(parsedTree, diceGroups, parserOptions)
	validateDiceGroups(diceGroups, parserOptions)
	const physicalGroups = maybeApplyLegacySingleModifier(
		maybeApplyPercentileSingleDie(diceGroups, originalNotation),
		parsedTree,
		originalNotation,
	)

	return {
		originalNotation,
		parserNotation,
		diceGroups: physicalGroups,
		parsedTree,
		mode: 'advanced',
	}
}

const legacyValidNumber = (value, fallback, notationText) => {
	const number = value === '' || value === undefined ? fallback : Number(value)
	if (Number.isNaN(number) || !Number.isInteger(number) || number < 1) {
		throw notationError(`Invalid notation: ${notationText}`)
	}
	return number
}

export const parseLegacySimpleNotation = (input, diceAvailable = [], options = {}) => {
	const parserOptions = toOptions(options)
	const notation = Array.isArray(input)
		? input
		: String(input).split(',').map(part => part.trim()).filter(Boolean)

	const parsedNotation = []
	const percentNotation = /^(\d*)[dD](00|%)([+-]\d+)?$/i
	const fudgeNotation = /^(\d*)[dD](f+[ate]*)([+-]\d+)?$/i
	const diceNotation = /^(\d*)[dD](\d+)([+-]\d+)?$/i
	const customNotation = /^(\d*)[dD]([\d\w]+)([+-]\d+)?$/i

	notation.forEach(roll => {
		if (typeof roll === 'object' && roll !== null) {
			if (!roll.sides) {
				throw notationError('Roll notation is missing sides')
			}
			parsedNotation.push({ qty: 1, modifier: 0, ...roll })
			return
		}

		const cleanNotation = String(roll).trim().replace(/\s+/g, '')
		const match = cleanNotation.match(percentNotation)
			|| cleanNotation.match(fudgeNotation)
			|| cleanNotation.match(diceNotation)
			|| cleanNotation.match(customNotation)

		if (!match || match.length < 3) {
			throw notationError(`Invalid notation: ${roll}`)
		}

		let modifier = 0
		if (match[3]) {
			modifier = Number(match[3])
		}

		const returnObj = {
			qty: legacyValidNumber(match[1], 1, roll),
			modifier,
			notation: cleanNotation,
		}

		if (cleanNotation.match(percentNotation)) {
			returnObj.sides = 'd100'
			returnObj.data = 'single'
		} else if (cleanNotation.match(fudgeNotation)) {
			returnObj.sides = 'fate'
		} else if (cleanNotation.match(diceNotation)) {
			const sides = legacyValidNumber(match[2], 1, roll)
			returnObj.sides = `d${sides}`
		} else if (diceAvailable.includes(match[2])) {
			returnObj.sides = match[2]
		} else {
			throw notationError(`Invalid notation: ${roll}`)
		}

		parsedNotation.push(returnObj)
	})

	validateDiceGroups(parsedNotation, parserOptions)
	return parsedNotation
}

export const parseRollNotationInput = (input, diceAvailable = [], options = {}) => {
	if (typeof input === 'string') {
		try {
			return parseAdvancedNotation(input, options)
		} catch (error) {
			try {
				const diceGroups = parseLegacySimpleNotation(input, diceAvailable, options)
				return {
					originalNotation: input.trim(),
					parserNotation: null,
					diceGroups,
					parsedTree: null,
					mode: 'legacy',
					advancedError: error.message,
				}
			} catch (legacyError) {
				throw error
			}
		}
	}

	return {
		originalNotation: Array.isArray(input) ? input.join(',') : '',
		parserNotation: null,
		diceGroups: parseLegacySimpleNotation(input, diceAvailable, options),
		parsedTree: null,
		mode: 'legacy',
	}
}

const sidesFromRoll = roll => {
	if (roll.sides === 'fate') {
		return 'fate'
	}
	if (Number.isInteger(roll.sides)) {
		return roll.sides
	}
	if (typeof roll.sides === 'string') {
		const numeric = parseInt(roll.sides.replace(/\D/g, ''), 10)
		if (Number.isInteger(numeric)) {
			return numeric
		}
	}
	if (typeof roll.dieType === 'string') {
		const numeric = parseInt(roll.dieType.replace(/\D/g, ''), 10)
		if (Number.isInteger(numeric)) {
			return numeric
		}
	}
	throw notationError('Unable to determine die sides from physical roll results.')
}

const valueToParserRandom = roll => {
	const value = Number(roll.value)
	const sides = sidesFromRoll(roll)

	if (sides === 'fate') {
		if (![ -1, 0, 1 ].includes(value)) {
			throw notationError(`Invalid fate die result '${roll.value}'.`)
		}
		return value === -1 ? 0 : value === 0 ? 1 / 3 : 2 / 3
	}

	if (!Number.isInteger(value) || value < 1 || value > sides) {
		throw notationError(`Invalid d${sides} physical result '${roll.value}'.`)
	}
	return (value - 1) / sides
}

export const flattenPhysicalRolls = physicalResults => {
	if (!Array.isArray(physicalResults)) {
		return []
	}
	return physicalResults.flatMap(group => {
		if (Array.isArray(group.rolls)) {
			return group.rolls
		}
		return group?.value !== undefined ? [group] : []
	})
}

export const computeFinalResult = (parsedTree, physicalResults, options = {}) => {
	const parserOptions = toOptions(options)
	const notation = options.originalNotation || options.notation || ''

	if (!parsedTree) {
		const value = physicalResults.reduce((total, group) => total + (Number(group.value) || 0), 0)
		return {
			value,
			notation,
			type: 'legacy',
			success: null,
			successes: 0,
			failures: 0,
		}
	}

	const physicalRolls = flattenPhysicalRolls(physicalResults)
	let index = 0
	const roller = new DiceRoller(() => {
		if (!physicalRolls[index]) {
			throw notationError('Parser requested more dice than were physically rolled.')
		}
		return valueToParserRandom(physicalRolls[index++])
	}, parserOptions.maxRerollDepth)

	const result = roller.rollParsed(parsedTree)
	if (index !== physicalRolls.length) {
		throw notationError('Physical roll results did not match parsed dice notation.')
	}

	return {
		value: result.value,
		notation,
		type: result.type,
		success: result.success ?? null,
		successes: result.successes || 0,
		failures: result.failures || 0,
		details: cloneForMetadata(result),
	}
}
