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

const cases = [
	['2d20kh1', [4, 17], 17],
	['2d20kl1', [4, 17], 4],
	['1d20 + 1d4 + 1d6+4', [10, 2, 5], 21],
	['4d6dl1', [1, 3, 4, 6], 13],
	['5d10>8', [8, 9, 10, 7, 1], 3],
	['{2d6,3d6}kh1', [1, 1, 4, 4, 4], 12],
]

for (const [notation, values, expected] of cases) {
	const parsedRoll = parseAdvancedNotation(notation)
	const physicalResults = createPhysicalResults(parsedRoll, values)
	const finalResult = computeFinalResult(parsedRoll.parsedTree, physicalResults, {
		originalNotation: notation,
	})

	assert.equal(finalResult.value, expected, notation)
	assert.equal(finalResult.notation, notation, notation)
}

assert.throws(
	() => parseRollNotationInput('@mod + 1d20'),
	/unresolved app token/,
)

assert.throws(
	() => parseRollNotationInput('6d6!'),
	/not yet supported in the replay API/,
)

console.log(`Verified ${cases.length} Roll20 adapter cases.`)
