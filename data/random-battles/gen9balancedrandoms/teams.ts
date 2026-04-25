import type { PRNG, PRNGSeed } from "../../../sim/prng";
import { RandomTeams } from "../gen9/teams";
import * as cheerio from "cheerio";
import { FS } from "../../../lib/fs";
import { build } from "esbuild";
import { writeFileSync } from "fs";

const LIMITLESS_NAME_ALIASES: { [k: string]: string; } = {
	bloodmoonursaluna: 'Ursaluna-Bloodmoon',
	rapidstrikeurshifu: 'Urshifu-Rapid-Strike',
	singlestrikeurshifu: 'Urshifu-Single-Strike',
	femaleindeedee: 'Indeedee-F',
	maleindeedee: 'Indeedee',
	hearthflamemaskogerpon: 'Ogerpon-Hearthflame',
	wellspringmaskogerpon: 'Ogerpon-Wellspring',
	cornerstonemaskogerpon: 'Ogerpon-Cornerstone',
	paldeantaurosaquabreed: 'Tauros-Paldea-Aqua',
	paldeantaurosblazebreed: 'Tauros-Paldea-Blaze',
	paldeantauroscombatbreed: 'Tauros-Paldea',
	tatsugiristretchyform: 'Tatsugiri-Stretchy',
	tatsugiridroopyform: 'Tatsugiri-Droopy',
	tatsugiricurlyform: 'Tatsugiri',
};

const OFFLINE_REGULATION_CONFIGS = {

	filePath: 'data/random-battles/gen9balancedrandoms/doubles-set.json',
	limitlessFormat: 'svi',
	
} as const;
type OfflineRegulation = string;

type OfflineTeamCacheFile = {
	regulation: string;
	limitlessFormat: string;
	generatedAt: string;
	teams: OfflineTeamEntry[];
};

type OfflineTeamEntry = {
	teamId: number;
	team: Pokemon[];
};

function getSpeciesNameCandidates(rawName: string): string[] {
	const trimmed = rawName.trim();
	const candidates = new Set<string>();
	if (!trimmed) return [];

	candidates.add(trimmed);
	candidates.add(trimmed.replace(/\s+/g, '-'));

	const words = trimmed.split(/[\s-]+/).filter(Boolean);
	for (let i = 1; i < words.length; i++) {
		const left = words.slice(0, i).join('-');
		const right = words.slice(i).join('-');
		candidates.add(`${left}-${right}`);
		candidates.add(`${right}-${left}`);
	}

	return [...candidates];
}

/**
 * Balanced Random Teams for Gen 9
 * Currently a simplified implementation that returns 6 random Pokemon
 */

async function fetchTeamIdsFromLimitless(show: number, limitlessFormat: string) {
	const regex = /<td><a href="\/teams\/(\d+)"/g;
	const response = await fetch(`https://limitlessvgc.com/teams?show=${show}&format=${limitlessFormat}&time=all`);
	if (!response.ok) {
		throw new Error(`HTTP error fetching team list (${limitlessFormat}): ${response.status}`);
	}
	const data = await response.text();
	return [...data.matchAll(regex)].map(m => Number(m[1])).filter(id => Number.isInteger(id));
}

export async function GrabTeamsFromLimitless(show: number = 30, format?: string) {
	const regex = /<td><a href="\/teams\/(\d+)"/g;
	const allFormats = ["sva", "svb", 'svc', 'svd', 'sve', 'svf', 'svg', 'svh', 'svi'];
	const randomFormat = format || allFormats[Math.floor(Math.random() * allFormats.length)];
	let teamIds: number[] = [];
	const response = await fetch(`https://limitlessvgc.com/teams?show=${show}&format=${randomFormat}&time=all`);
	if (!response.ok) {
		throw new Error(`HTTP error! status: ${response.status}`);
	} else {
		const data = await response.text();
		teamIds = [...data.matchAll(regex)].map(m => Number(m[1]));

	}

	const randomIndex = Math.floor(Math.random() * teamIds.length);
	const id = teamIds[randomIndex];
	const teamResponse = await fetch(`https://limitlessvgc.com/teams/${id}`);
	if (!teamResponse.ok) {
		console.error(`Failed to fetch team with ID ${id}: ${teamResponse.status}`);
		return [];
	}
	const teamHtml = await teamResponse.text();
	const team = parseTeam(teamHtml);
	return team;
}


async function grabRandomTeamForFormat(show: number, limitlessFormat: string): Promise<OfflineTeamEntry | null> {
	const teamIds = await fetchTeamIdsFromLimitless(show, limitlessFormat);
	if (!teamIds.length) return null;
	const randomIndex = Math.floor(Math.random() * teamIds.length);
	const id = teamIds[randomIndex];
	const teamResponse = await fetch(`https://limitlessvgc.com/teams/${id}`);
	if (!teamResponse.ok) return null;
	const teamHtml = await teamResponse.text();
	return { teamId: id, team: parseTeam(teamHtml) };
}


export type Pokemon = {
	name: string;
	item: string;
	teraType: string;
	moves: string[];
};

export function parseTeam(html: string): Pokemon[] {
	const $ = cheerio.load(html);

	const team: Pokemon[] = [];

	$("div.pkmn").each((_, el) => {
		const root = $(el);

		const name = root.find(".name a").text().trim();

		const item = root.find(".details .item").first().text().trim();

		const teraText = root.find(".tera").text().trim();
		const teraType = teraText.replace("Tera Type:", "").trim();

		const moves: string[] = [];

		root.find(".moves li").each((_, moveEl) => {
			const move = $(moveEl).text().trim();
			if (move) moves.push(move);
		});

		if (name) {
			team.push({
				name,
				item,
				teraType,
				moves,
			});
		}
	});

	return team;
}

function readOfflineCache(regulation: OfflineRegulation): OfflineTeamCacheFile | null {
	const { filePath, limitlessFormat } = OFFLINE_REGULATION_CONFIGS;
	const raw = FS(filePath).readIfExistsSync();
	if (!raw) return null;

	try {
		const parsed = JSON.parse(raw);
		if (!parsed || !Array.isArray(parsed.teams)) return null;
		const teams: OfflineTeamEntry[] = parsed.teams.map((entry: Pokemon[] | OfflineTeamEntry, index: number) => {
			if (Array.isArray(entry)) {
				return { teamId: index + 1, team: entry };
			}
			return {
				teamId: Number(entry.teamId) || index + 1,
				team: Array.isArray(entry.team) ? entry.team : [],
			};
		}).filter((entry: OfflineTeamEntry) => entry.team.length);
		return {
			regulation,
			limitlessFormat: parsed.limitlessFormat || limitlessFormat,
			generatedAt: parsed.generatedAt || '',
			teams,
		};
	} catch {
		console.error(`[gen9balancedrandoms] Failed to parse offline cache file: ${filePath}`);
		return null;
	}
}

export async function buildOfflineCacheForRegulation(
	regulation = OFFLINE_REGULATION_CONFIGS.limitlessFormat,
	count = 50,
	show = 200
) {
	const { filePath, limitlessFormat } = OFFLINE_REGULATION_CONFIGS;
	const teams: OfflineTeamEntry[] = [];
	const seenSignatures = new Set<string>();
	let attempts = 0;
	const maxAttempts = Math.max(count * 8, 100);

	while (teams.length < count && attempts < maxAttempts) {
		attempts++;
		try {
			const result = await grabRandomTeamForFormat(show, limitlessFormat);
			if (!result || !result.team.length || result.team.length < 6) continue;
			const signature = result.team
				.map((p: Pokemon) => `${p.name}|${p.item}|${p.moves.join('/')}`)
				.sort()
				.join('||');
			if (seenSignatures.has(signature)) continue;
			seenSignatures.add(signature);
			teams.push(result);
		} catch (error) {
			console.error(`[gen9balancedrandoms] Failed to fetch ${regulation} team:`, error);
		}
	}

	const payload: OfflineTeamCacheFile = {
		regulation,
		limitlessFormat,
		generatedAt: new Date().toISOString(),
		teams,
	};

	await FS(filePath).safeWrite(JSON.stringify(payload, null, 2) + '\n');
	console.log(`[gen9balancedrandoms] Wrote ${teams.length} teams to ${filePath}`);
	return teams.length;
}

buildOfflineCacheForRegulation();

export class RandomBalancedTeams extends RandomTeams {
	private offlineRegulation: OfflineRegulation | null = null;

	constructor(format: Format | string, prng: PRNG | PRNGSeed | null) {
		super(format, prng);
	}

	override randomSets: { [species: string]: RandomTeamsTypes.RandomSpeciesData; } = require('../gen9/doubles-sets.json');

	private resolveLimitlessSpecies(name: string): Species {
		for (const candidate of getSpeciesNameCandidates(name)) {
			const species = this.dex.species.get(candidate);
			if (species.exists) return species;
		}

		const aliasName = LIMITLESS_NAME_ALIASES[name.toLowerCase().replace(/[^a-z0-9]/g, '')];
		if (aliasName) {
			const species = this.dex.species.get(aliasName);
			if (species.exists) return species;
		}

		return this.dex.species.get(name);
	}

	private getSmartTemplateFromRandomSet(species: Species, moves: string[], item: string) {
		const speciesData = (this.randomSets[species.id] as any)?.sets;
		if (!Array.isArray(speciesData) || !speciesData.length) return null;

		const importedMoveIds = new Set(
			moves.map(move => this.dex.moves.get(move).id).filter(Boolean)
		);
		let best: AnyObject | null = null;
		let bestScore = -1;

		for (let i = 0; i < 20; i++) {
			let candidate: AnyObject | null = null;
			try {
				candidate = this.randomSet(species, {}, false, true) as AnyObject;
			} catch {
				return null;
			}
			const candidateMoves = Array.isArray(candidate.moves) ? candidate.moves : [];
			let overlap = 0;
			for (const move of candidateMoves) {
				if (importedMoveIds.has(move)) overlap++;
			}

			let score = overlap * 10;
			if (item && candidate.item === item) score += 3;
			if (candidate.ability === species.abilities['0']) score += 1;

			if (score > bestScore) {
				best = candidate;
				bestScore = score;
			}
		}

		return best;
	}

	private toPokemonSetFromLimitless(pokemon: Pokemon): PokemonSet | null {
		const species = this.resolveLimitlessSpecies(pokemon.name);
		if (!species.exists) {
			console.warn(`Species ${pokemon.name} not found in dex, skipping.`);
			return null;
		}

		const gender = (species.gender === 'M' || species.gender === 'F') ? species.gender : '';
		const moves = pokemon.moves.slice(0, 4);
		if (!moves.length) return null;
		const template = this.getSmartTemplateFromRandomSet(species, moves, pokemon.item || '');
		const ability = template?.ability || species.abilities['0'] || '';
		const nature = template?.nature || 'Serious';
		const evs = template?.evs || { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
		const ivs = template?.ivs || { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
		const level = 50;

		return {
			name: species.baseSpecies,
			species: species.name,
			item: pokemon.item || '',
			ability,
			moves,
			nature,
			evs,
			ivs,
			level,
			gender,
			teraType: pokemon.teraType,
		};
	}

	private randomFallbackTeam(): PokemonSet[] {
		const team: PokemonSet[] = [];
		const usedSpecies = new Set<string>();
		const usedItems = new Set<string>();
		const pokemonPool = Object.keys(this.randomSets);

		while (pokemonPool.length && team.length < this.maxTeamSize) {
			const name = this.sampleNoReplace(pokemonPool) as string;
			const species = this.dex.species.get(name);
			if (!species.exists || usedSpecies.has(species.baseSpecies)) continue;

			const speciesData = (this.randomSets[species.id] as any)?.sets || [];
			if (!Array.isArray(speciesData) || !speciesData.length) continue;

			const setPool = [...speciesData];
			let setData: any = null;
			while (setPool.length) {
				const candidate = this.sampleNoReplace(setPool) as any;
				const itemKey = (candidate.item || '').toLowerCase();
				if (itemKey && usedItems.has(itemKey)) continue;
				setData = candidate;
				break;
			}
			if (!setData) continue;

			const gender = (
				setData.gender || (species.gender === 'M' || species.gender === 'F' ? species.gender : '')
			);
			const item = setData.item || '';
			if (item) usedItems.add(item.toLowerCase());

			const set: PokemonSet = {
				name: species.baseSpecies,
				species: species.name,
				item,
				ability: setData.ability || '',
				moves: (setData.moves || []).slice(0, 4),
				nature: setData.nature || 'Serious',
				evs: setData.evs || { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
				ivs: setData.ivs || { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
				level: setData.level || 50,
				gender,
				shiny: setData.shiny || false,
			};

			team.push(set);
			usedSpecies.add(species.baseSpecies);
		}

		// If item uniqueness is too restrictive to fill 6, relax it to ensure full teams.
		if (team.length < this.maxTeamSize) {
			const refillPool = Object.keys(this.randomSets);
			while (refillPool.length && team.length < this.maxTeamSize) {
				const name = this.sampleNoReplace(refillPool) as string;
				const species = this.dex.species.get(name);
				if (!species.exists || usedSpecies.has(species.baseSpecies)) continue;

				const speciesData = (this.randomSets[species.id] as any)?.sets || [];
				if (!Array.isArray(speciesData) || !speciesData.length) continue;

				const setData = this.sample(speciesData) as any;
				const gender = (
					setData.gender || (species.gender === 'M' || species.gender === 'F' ? species.gender : '')
				);

				team.push({
					name: species.baseSpecies,
					species: species.name,
					item: setData.item || '',
					ability: setData.ability || '',
					moves: (setData.moves || []).slice(0, 4),
					nature: setData.nature || 'Serious',
					evs: setData.evs || { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
					ivs: setData.ivs || { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
					level: setData.level || 50,
					gender,
					shiny: setData.shiny || false,
				});
				usedSpecies.add(species.baseSpecies);
			}
		}

		return team;
	}

	randomBalancedTeam(): PokemonSet[] {
		this.enforceNoDirectCustomBanlistChanges();

		const selectedPool = readOfflineCache('regA');
		if (selectedPool?.teams.length) {
			this.offlineRegulation = 'regA';
			const cachedEntry = this.sample(selectedPool.teams);
			const cachedTeam = cachedEntry.team;
			const team: PokemonSet[] = [];
			const usedSpecies = new Set<string>();
			const usedItems = new Set<string>();

			for (const pokemon of cachedTeam) {
				const set = this.toPokemonSetFromLimitless(pokemon);
				if (!set) continue;

				const species = this.dex.species.get(set.species);
				if (!species.exists || usedSpecies.has(species.baseSpecies)) continue;

				const itemKey = set.item.toLowerCase();
				if (itemKey && usedItems.has(itemKey)) continue;

				team.push(set);
				usedSpecies.add(species.baseSpecies);
				if (itemKey) usedItems.add(itemKey);
				if (team.length >= this.maxTeamSize) break;
			}

			(team as PokemonSet[] & { __limitlessTeamInfo?: AnyObject; }).__limitlessTeamInfo = {
				teamId: cachedEntry.teamId,
				regulation: selectedPool.regulation,
				limitlessFormat: selectedPool.limitlessFormat,
			};

			if (team.length >= this.maxTeamSize) return team;
			console.warn(
				`[gen9balancedrandoms] Offline regA team #${cachedEntry.teamId} only produced ${team.length}/${this.maxTeamSize}; using fallback.`
			);
		}

		const fallbackTeam = this.randomFallbackTeam();
		(fallbackTeam as PokemonSet[] & { __limitlessTeamInfo?: AnyObject; }).__limitlessTeamInfo = {
			teamId: null,
			regulation: 'fallback',
			limitlessFormat: '',
		};
		return fallbackTeam;
	}
}

export default RandomBalancedTeams;
