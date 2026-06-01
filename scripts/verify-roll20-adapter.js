import assert from 'node:assert/strict'

import {
	computeFinalResult,
	parseAdvancedNotation,
	parseRollNotationInput,
} from '../src/parser/roll20Adapter.js'

const numericSides = sides => {
	if (sides === 'fate') {
		return 'fate'
	}
	return Number(String(sides).replace(/\D/g, ''))
}

const createPhysicalResults = (parsedRoll, values) => {
	let rollIndex = 0
	return parsedRoll.diceGroups.map((group, groupId) => {
		const rolls = Array.from({ length: group.qty }, () => {
			const value = values[rollIndex]
			return {
				sides: numericSides(group.sides),
				dieType: group.sides,
				groupId,
				rollId: rollIndex++,
				value,
			}
		})

		return {
			id: groupId,
			qty: group.qty,
			sides: group.sides,
			modifier: group.modifier || 0,
			notation: group.notation,
			value: rolls.reduce((total, roll) => total + roll.value, 0) + (group.modifier || 0),
			rolls,
		}
	})
}

const appendPhysicalRolls = (physicalResults, { sides, values }) => {
	const dieType = sides === 'fate' ? 'fate' : `d${sides}`
	let rollIndex = physicalResults.flatMap(group => group.rolls || []).length
	values.forEach(value => {
		const groupId = physicalResults.length
		physicalResults.push({
			id: groupId,
			qty: 1,
			sides: dieType,
			modifier: 0,
			notation: sides === 'fate' ? '1dF' : `1d${sides}`,
			reroll: true,
			value,
			rolls: [{
				sides,
				dieType,
				groupId,
				rollId: rollIndex++,
				reroll: true,
				value,
			}],
		})
	})
}

const cases = [
	{ notation: '2d20kh1', values: [4, 17], expected: 17 },
	{ notation: '2d20kl1', values: [4, 17], expected: 4 },
	{ notation: '1d20 + 1d4 + 1d6+4', values: [10, 2, 5], expected: 21 },
	{ notation: '4d6dl1', values: [1, 3, 4, 6], expected: 13 },
	{ notation: '5d10>8', values: [8, 9, 10, 7, 1], expected: 3, assert: finalResult => assert.equal(finalResult.successes, 3) },
	{ notation: '{2d6,3d6}kh1', values: [1, 1, 4, 4, 4], expected: 12 },
	{
		notation: '10d6sa',
		values: [3, 1, 6, 2, 5, 4, 1, 6, 2, 5],
		expected: 35,
		assert: (finalResult, physicalResults) => {
			const ordered = physicalResults
				.flatMap(group => group.rolls)
				.slice()
				.sort((a, b) => a.parser.order - b.parser.order)
				.map(roll => roll.value)
			assert.deepEqual(ordered, [1, 1, 2, 2, 3, 4, 5, 5, 6, 6])
		},
	},
	{
		notation: '4d6m',
		values: [2, 2, 5, 6],
		expected: 15,
		assert: (finalResult, physicalResults) => {
			const matched = physicalResults.flatMap(group => group.rolls).filter(roll => roll.parser.matched)
			assert.equal(matched.length, 2)
			assert.deepEqual(matched.map(roll => roll.value), [2, 2])
		},
	},
	{
		notation: '4d6cs=5cf=2',
		values: [2, 3, 5, 6],
		expected: 16,
		assert: (finalResult, physicalResults) => {
			const critical = physicalResults.flatMap(group => group.rolls).map(roll => roll.parser.critical)
			assert.deepEqual(critical, ['failure', null, 'success', null])
		},
	},
	{ notation: 'floor(1d6/2)', values: [5], expected: 2 },
	{ notation: 'ceil(1d6/2)', values: [5], expected: 3 },
	{ notation: 'round(1d6/2)', values: [5], expected: 3 },
	{ notation: 'abs(1d6-8)', values: [5], expected: 3 },
	{
		notation: '6d6!',
		values: [6, 2, 3, 4, 5, 1],
		extra: { sides: 6, values: [4] },
		expected: 25,
		options: { allowRerollingMods: true },
		assert: (finalResult, physicalResults) => {
			const rolls = physicalResults.flatMap(group => group.rolls)
			assert.equal(rolls.length, 7)
			assert.equal(rolls[0].parser.explode, true)
			assert.equal(rolls[6].parser.valid, true)
		},
	},
	{
		notation: '6d6!!',
		values: [6, 6, 3, 4, 5, 1],
		extra: { sides: 6, values: [4, 2] },
		expected: 31,
		options: { allowRerollingMods: true },
		assert: (finalResult, physicalResults) => {
			const folded = physicalResults.flatMap(group => group.rolls).filter(roll => roll.parser.folded)
			assert.equal(folded.length, 2)
			assert.deepEqual(folded.map(roll => roll.value), [4, 2])
		},
	},
	{
		notation: '6d6!p',
		values: [6, 6, 3, 4, 5, 1],
		extra: { sides: 6, values: [4, 2] },
		expected: 29,
		options: { allowRerollingMods: true },
	},
	{
		notation: '6d6r1',
		values: [1, 1, 3, 4, 5, 6],
		extra: { sides: 6, values: [2, 3] },
		expected: 23,
		options: { allowRerollingMods: true },
		assert: (finalResult, physicalResults) => {
			const rerolled = physicalResults.flatMap(group => group.rolls).filter(roll => roll.parser.reroll)
			assert.equal(rerolled.length, 2)
			assert.equal(rerolled.every(roll => roll.parser.valid === false), true)
		},
	},
	{
		notation: '6d6ro1',
		values: [1, 1, 3, 4, 5, 6],
		extra: { sides: 6, values: [2, 3] },
		expected: 23,
		options: { allowRerollingMods: true },
	},
]

for (const { notation, values, extra, expected, options = {}, assert: assertCase } of cases) {
	const parsedRoll = parseAdvancedNotation(notation, options)
	const physicalResults = createPhysicalResults(parsedRoll, values)
	if (extra) {
		appendPhysicalRolls(physicalResults, extra)
	}
	const finalResult = computeFinalResult(parsedRoll.parsedTree, physicalResults, {
		originalNotation: notation,
		...options,
	})

	assert.equal(finalResult.value, expected, notation)
	assert.equal(finalResult.notation, notation, notation)
	assert.equal(physicalResults.flatMap(group => group.rolls).every(roll => roll.parser), true, `${notation} missing parser metadata`)
	assertCase?.(finalResult, physicalResults)
}

assert.throws(
	() => parseRollNotationInput('@mod + 1d20'),
	/unresolved app token/,
)

assert.throws(
	() => parseRollNotationInput('101d6'),
	/Maximum dice count/,
)

assert.throws(
	() => parseRollNotationInput('1d101'),
	/maximum die size/,
)

assert.throws(
	() => parseRollNotationInput('1d6', [], { maxNotationLength: 2 }),
	/too long/,
)

console.log(`Verified ${cases.length} Roll20 adapter cases.`)
