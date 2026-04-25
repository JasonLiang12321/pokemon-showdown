/**
 * VGC Triple Draft - Pokemon Showdown Chat Plugin
 * 
 * Players pick Pokémon simultaneously in rounds until they have a full team.
 * Similar to Clash Royale's Triple Draft mode.
 * 
 * Format: Players pick 6 Pokémon (2 per round × 3 rounds) with 10 seconds per pick.
 * After picking, a doubles (4v4) battle starts with Open Team Sheets.
 */

import { Net, Utils } from '../../lib';

interface DraftPick {
	playerID: ID;
	pokemon: string;
	timestamp: number;
}

interface PickRound {
	options: string[]; // The 3 pokemon available this round
	picks: Map<ID, string>; // playerID -> picked pokemon
	started: number;
}

export class TripleDraftPlayer extends Rooms.RoomGamePlayer {
	team: string[] = [];
	currentPick: string | null = null;

	constructor(user: User | string | null, game: TripleDraft, num = 0) {
		super(user, game, num);
	}
}

export class TripleDraft extends Rooms.RoomGame {
	override readonly gameid = 'triple-draft' as ID;
	override playerCap = 2;
	declare players: TripleDraftPlayer[];
	declare playerTable: { [userid: string]: TripleDraftPlayer; };

	state: 'setup' | 'picking' | 'complete' = 'setup';
	roundCount = 3; // Total rounds
	currentRound = 0;
	picksPerRound = 2;
	pickTimeLimit = 10; // seconds
	pickTimeRemaining = 0;
	pickTimer: NodeJS.Timeout | null = null;

	pickPool: string[] = []; // Available pokemon for drafting
	currentRoundOptions: string[] = []; // This round's 3 choices
	roundPicks: Map<ID, string> = new Map(); // Current round picks

	constructor(room: Room) {
		super(room);
		this.title = 'VGC Triple Draft';
	}

	override makePlayer(user: User | string | null): TripleDraftPlayer {
		const num = this.players.length ? this.players[this.players.length - 1].num + 1 : 1;
		return new TripleDraftPlayer(user, this, num);
	}

	private sendMessage(message: string) {
		this.room.add(`|c|~|${message}`).update();
	}

	private sendHTMLBox(htmlContent: string) {
		this.room.add(`|html|<div class="infobox">${htmlContent}</div>`).update();
	}

	private generatePickDisplay(): string {
		let buf = `<div class="ladder pad" style="margin: 5px 0">`;
		buf += `<h3>Round ${this.currentRound + 1}/${this.roundCount}</h3>`;
		buf += `<table style="width: 100%">`;
		buf += `<tr><th>Pick Option</th><th>Votes</th></tr>`;

		for (const option of this.currentRoundOptions) {
			const votes = Array.from(this.roundPicks.values()).filter(p => p === option).length;
			const totalVotes = this.roundPicks.size;
			const voteBar = votes > 0 ? `${votes}/${totalVotes}` : '0/${totalVotes}';
			buf += `<tr><td>${Utils.escapeHTML(option)}</td><td>${voteBar}</td></tr>`;
		}

		buf += `</table>`;
		buf += `<div style="color: #666; font-size: 12px; margin-top: 5px;">`;
		buf += `${this.pickTimeRemaining} seconds remaining`;
		buf += `</div></div>`;

		return buf;
	}

	private generateTeamDisplay(player: TripleDraftPlayer): string {
		let buf = `<div class="ladder pad" style="margin: 5px 0">`;
		buf += `<h4>${Utils.escapeHTML(player.name)}'s Team</h4>`;
		buf += `<div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px;">`;

		for (let i = 0; i < 6; i++) {
			const pokemon = player.team[i] || '(empty)';
			buf += `<div style="padding: 5px; background: ${i < player.team.length ? '#ccc' : '#eee'};">`;
			buf += Utils.escapeHTML(pokemon);
			buf += `</div>`;
		}

		buf += `</div></div>`;
		return buf;
	}

	private getAvailablePokemon(): string[] {
		// Get all obtainable Gen 9 Pokémon
		const available: string[] = [];

		for (const [key, species] of Object.entries(Dex.data.Pokedex)) {
			if (species.isNonstandard && species.isNonstandard !== 'Gigantamax') continue;
			available.push(species.name);
		}

		return available;
	}

	private generateRoundOptions(): string[] {
		const options: string[] = [];
		const available = new Set(this.pickPool);

		// Remove already picked pokemon
		for (const player of this.players) {
			for (const pokemon of player.team) {
				available.delete(pokemon);
			}
		}

		const availableArray = Array.from(available);
		const PICKS_PER_OPTION = 3;

		for (let i = 0; i < PICKS_PER_OPTION; i++) {
			if (availableArray.length === 0) break;
			const idx = Math.floor(Math.random() * availableArray.length);
			options.push(availableArray[idx]);
			availableArray.splice(idx, 1);
		}

		return options;
	}

	private startPickRound() {
		this.currentRound++;
		this.roundPicks.clear();

		if (this.currentRound > this.roundCount) {
			return this.finishDraft();
		}

		// Generate 3 options per player in this round (3 total options)
		this.currentRoundOptions = this.generateRoundOptions();

		this.state = 'picking';
		this.pickTimeRemaining = this.pickTimeLimit;

		// Display pick options to all players
		let display = `<div>`;
		display += `<h2>Pick a Pokémon! (Round ${this.currentRound}/${this.roundCount})</h2>`;
		display += `<div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 10px 0;">`;

		for (const option of this.currentRoundOptions) {
			display += `<div style="padding: 10px; background: #ddd; border: 1px solid #999; cursor: pointer; text-align: center;">`;
			display += `<button style="width: 100%; padding: 5px; cursor: pointer;">`;
			display += Utils.escapeHTML(option);
			display += `</button>`;
			display += `</div>`;
		}

		display += `</div>`;
		display += `</div>`;

		this.sendHTMLBox(display);
		this.sendMessage(`Round ${this.currentRound} of ${this.roundCount} started! Pick a Pokémon!`);

		this.startPickTimer();
	}

	private startPickTimer() {
		this.clearPickTimer();
		this.pickTimeRemaining = this.pickTimeLimit;
		this.sendPickTimerUpdate();

		this.pickTimer = setInterval(() => {
			this.pickTimeRemaining--;
			this.sendPickTimerUpdate();

			if (this.pickTimeRemaining <= 0) {
				this.finishPickRound();
			}
		}, 1000);
	}

	private clearPickTimer() {
		if (this.pickTimer) clearInterval(this.pickTimer);
		this.pickTimer = null;
	}

	private sendPickTimerUpdate() {
		const buf = `<div style="text-align: center; font-size: 20px; font-weight: bold; color: ${this.pickTimeRemaining <= 5 ? 'red' : 'black'};">`;
		const buf2 = buf + `${this.pickTimeRemaining}s remaining</div>`;
		this.room.add(`|uhtmlchange|pick-timer|${buf2}`);
		this.room.update();
	}

	private finishPickRound() {
		this.clearPickTimer();

		// Check if all players have picked, if not, pick randomly
		for (const player of this.players) {
			if (!this.roundPicks.has(player.id)) {
				const randomOption = this.currentRoundOptions[
					Math.floor(Math.random() * this.currentRoundOptions.length)
				];
				this.roundPicks.set(player.id, randomOption);
			}
		}

		// Add picks to player teams
		for (const [playerID, pokemon] of this.roundPicks.entries()) {
			const player = this.playerTable[playerID];
			if (player && player.team.length < 6) {
				player.team.push(pokemon);
			}
		}

		// Show results
		let results = `<div class="ladder pad"><h3>Round ${this.currentRound} Results</h3>`;
		for (const player of this.players) {
			results += this.generateTeamDisplay(player);
		}
		results += `</div>`;
		this.sendHTMLBox(results);

		this.room.update();

		// Wait a moment before starting next round
		setTimeout(() => {
			this.startPickRound();
		}, 2000);
	}

	private finishDraft() {
		this.clearPickTimer();
		this.state = 'complete';

		// All players have their 6 Pokémon
		let summary = `<div class="ladder pad"><h2>Draft Complete!</h2>`;
		for (const player of this.players) {
			summary += this.generateTeamDisplay(player);
		}
		summary += `</div>`;
		this.sendHTMLBox(summary);

		this.sendMessage(`The draft is complete! Teams have been selected.`);
		this.end();
	}

	start() {
		if (this.state !== 'setup') {
			throw new Chat.ErrorMessage(`The draft has already started.`);
		}
		if (this.players.length < 2) {
			throw new Chat.ErrorMessage(`At least 2 players are required to start a draft.`);
		}

		this.pickPool = this.getAvailablePokemon();
		this.startPickRound();
	}

	override choose(user: User, text: string) {
		if (this.state !== 'picking') {
			throw new Chat.ErrorMessage(`You can't pick right now.`);
		}

		const player = this.playerTable[user.id];
		if (!player) {
			throw new Chat.ErrorMessage(`You are not a player in this draft.`);
		}

		if (this.roundPicks.has(user.id)) {
			throw new Chat.ErrorMessage(`You have already picked in this round.`);
		}

		const choice = text.trim().toLowerCase();
		const validOption = this.currentRoundOptions.find(opt => opt.toLowerCase() === choice);

		if (!validOption) {
			throw new Chat.ErrorMessage(
				`Invalid choice. Available options: ${this.currentRoundOptions.join(', ')}`
			);
		}

		this.roundPicks.set(user.id, validOption);
		this.sendMessage(`${user.name} picked ${validOption}!`);

		// Check if all players have picked
		if (this.roundPicks.size === this.players.length) {
			this.finishPickRound();
		}
	}

	override onConnect(user: User, connection: Connection) {
		const player = this.playerTable[user.id];
		if (!player) return;

		let buf = `|init|game\n|title|${this.title}\n`;

		buf += `|raw|<div class="infobox">`;
		buf += `<h2>VGC Triple Draft</h2>`;
		buf += `<p>Pick Pokémon simultaneously in rounds to build your team!</p>`;
		buf += this.generateTeamDisplay(player);

		if (this.state === 'picking') {
			buf += `<h3>Current Round: ${this.currentRound}/${this.roundCount}</h3>`;
			buf += `<p>Available options: ${this.currentRoundOptions.join(', ')}</p>`;
		}

		buf += `</div>|`;

		user.sendTo(this.room, buf);
	}

	private end() {
		this.setEnded();
		this.room.game = null;
		this.destroy();
	}

	override destroy() {
		this.clearPickTimer();
		super.destroy();
	}
}

export const commands: Chat.ChatCommands = {
	tripledraft: {
		create(target, room, user) {
			room = this.requireRoom();
			if (room.game) {
				throw new Chat.ErrorMessage(`There is already a game of ${room.game.title} in progress.`);
			}

			const draft = new TripleDraft(room);
			draft.addPlayer(user);
			room.game = draft;

			this.addModAction(`${user.name} created a VGC Triple Draft.`);
			this.modlog(`TRIPLEDRAFT CREATE`, null, `by ${user.name}`);
		},
		createhelp: [
			`/tripledraft create - Creates a VGC Triple Draft game.`,
		],

		join(target, room, user) {
			room = this.requireRoom();
			const game = room.game as TripleDraft | null;
			if (!game || game.gameid !== 'triple-draft') {
				throw new Chat.ErrorMessage(`There is no Triple Draft in progress.`);
			}

			if (game.state !== 'setup') {
				throw new Chat.ErrorMessage(`The draft has already started.`);
			}

			const player = game.addPlayer(user);
			if (!player) {
				throw new Chat.ErrorMessage(`Could not join the draft (you may already be in it, or the draft is full).`);
			}

			this.addModAction(`${user.name} joined the Triple Draft.`);
		},
		joinhelp: [
			`/tripledraft join - Joins a VGC Triple Draft game.`,
		],

		start(target, room, user) {
			room = this.requireRoom();
			const game = room.game as TripleDraft | null;
			if (!game || game.gameid !== 'triple-draft') {
				throw new Chat.ErrorMessage(`There is no Triple Draft in progress.`);
			}

			game.start();
			this.addModAction(`${user.name} started the Triple Draft.`);
			this.modlog(`TRIPLEDRAFT START`);
		},
		starthelp: [
			`/tripledraft start - Starts the draft picking phase.`,
		],
	},
};
