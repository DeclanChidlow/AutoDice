const { Client } = require("stoat.js");

class DiceBot {
	constructor() {
		this.client = new Client();
		this.setupEvents();
	}

	setupEvents() {
		this.client.on("connect", () => {
			console.log(`AutoDice connected as ${this.client.user?.username}`);
		});

		this.client.on("error", (err) => {
			console.error("The client encountered an error:", err);
		});

		this.client.on("messageCreate", async (message) => {
			await this.handleMessage(message);
		});
	}

	async start() {
		await this.client.loginBot(process.env.BOT_TOKEN);
	}

	async getDmChannel(userId) {
		try {
			let user = this.client.users.get(userId) || (await this.client.users.fetch(userId));

			const existing = Array.from(this.client.channels.values()).find((c) => c.type === "DirectMessage" && c.recipient?.id === user.id);

			if (existing) return existing;
			return await user.openDM();
		} catch (error) {
			console.error("Direct Message Delivery Error:", error);
			return null;
		}
	}

	async handleMessage(message) {
		if (message.author?.bot || !message.content) return;

		let content = message.content.trim();
		const botMention = `<@${this.client.user?.id}>`;

		if (!content.startsWith(botMention)) return;

		content = content.slice(botMention.length).trim();
		if (!content) return;

		const args = content.split(/\s+/);
		const trigger = args[0].toLowerCase();

		if (trigger === "help") {
			return await this.sendHelp(message);
		}

		if (trigger === "support") {
			return await this.sendSupport(message);
		}

		let isDMRequest = false;
		if (["dm", "secret", "priv", "private"].includes(trigger)) {
			isDMRequest = true;
			args.shift();
		}

		const formula = args.join(" ");
		if (!this.isDiceString(formula)) return;

		await this.processRoll(message, formula, isDMRequest);
	}

	async processRoll(message, input, isPrivate) {
		const repeatMatch = input.match(/^(\d+)\s+(.*d.*)/i);
		let output = "";

		if (repeatMatch) {
			const count = Math.min(parseInt(repeatMatch[1]), 20);
			const formula = repeatMatch[2];
			output += `**Repeating ${count} times:** \`${formula}\`\n`;
			for (let i = 0; i < count; i++) {
				const res = this.calculateDice(formula);
				output += `${i + 1}. **${res.total}** \t${res.breakdown}\n`;
			}
		} else {
			const res = this.calculateDice(input);
			output = `🎲 **${res.total}**\n${res.breakdown}`;
		}

		if (isPrivate) {
			const dmChannel = await this.getDmChannel(message.authorId);
			if (dmChannel) {
				await dmChannel.sendMessage(output);
				await message.reply("✅ Sent to DMs.");
			} else {
				await message.reply("❌ Unable to send a DM.");
			}
		} else {
			await message.reply(output);
		}
	}

	isDiceString(str) {
		return /[0-9d]/.test(str) && /^[0-9d+\-*/().<>krlsha\s!]+$/i.test(str);
	}

	calculateDice(expression) {
		const diceRegex = /(\d+)?d(\d+)([a-z!<>=\d]*)/gi;
		const rolls = [];

		const evalString = expression.replace(diceRegex, (match, countStr, sidesStr, mods) => {
			const count = Math.min(parseInt(countStr || "1"), 100);
			const sides = Math.min(parseInt(sidesStr), 1000);
			const isExploding = mods && mods.includes("!");

			let results = [];

			for (let i = 0; i < count; i++) {
				let roll = Math.floor(Math.random() * sides) + 1;
				results.push({ val: roll, kept: true, exploded: false });

				let explosions = 0;
				while (isExploding && roll === sides && sides > 1 && explosions < 10) {
					roll = Math.floor(Math.random() * sides) + 1;
					results.push({ val: roll, kept: true, exploded: true });
					explosions++;
				}
			}

			if (mods) results = this.applyModifiers(results, mods, sides);

			const sum = results.filter((r) => r.kept).reduce((a, b) => a + b.val, 0);

			const formatted = results
				.map((r) => {
					let display = r.val;
					if (r.exploded) display = `${r.val}💥`;
					return r.kept ? `**${display}**` : `~~${display}~~`;
				})
				.join(", ");

			rolls.push(`${match} (${formatted})`);
			return `(${sum})`;
		});

		let total = 0;
		try {
			total = new Function(`return ${evalString.replace(/[^0-9+\-*/().\s]/g, "")}`)();
			if (!Number.isInteger(total)) total = Number(total).toFixed(2);
		} catch (e) {
			total = "Error";
		}

		return { total, breakdown: rolls.join(" + ") };
	}

	applyModifiers(results, modStr, sides) {
		// Reroll
		const rerollMatch = modStr.match(/r([<>=]?)(\d+)/);
		if (rerollMatch) {
			const op = rerollMatch[1] || "=";
			const target = parseInt(rerollMatch[2]);
			results.forEach((d) => {
				const trigger = (op === "=" && d.val === target) || (op === "<" && d.val < target) || (op === ">" && d.val > target);
				if (trigger) d.val = Math.floor(Math.random() * sides) + 1;
			});
		}

		// Keep/Drop
		const keepMatch = modStr.match(/k([hl])(\d+)/);
		if (keepMatch) {
			const type = keepMatch[1];
			const num = parseInt(keepMatch[2]);
			const sorted = [...results].sort((a, b) => b.val - a.val);
			const toKeep = type === "h" ? sorted.slice(0, num) : sorted.slice(-num);
			results.forEach((d) => {
				if (!toKeep.includes(d)) d.kept = false;
			});
		}

		// Sort
		if (modStr.includes("sd")) results.sort((a, b) => b.val - a.val);
		else if (["s", "sa"].some((opt) => modStr.includes(opt))) {
			results.sort((a, b) => a.val - b.val);
		}
		return results;
	}

	async sendHelp(message) {
		await message.reply(`## AutoDice Help

		Visit [the website](<https://automod.vale.rocks/BLANK>) for more usage information and [the AutoMod server](https://stt.gg/automod) for help.

		- **Basic Rolls:** Use \`@AutoDice [number]d[sides]\`. (eg \`@AutoDice 10d6\`).
		- **Math:** Supports \`+\`, \`-\`, \`*\`, \`/\`. Add modifiers like \`1d20 + 5\`.
		- **Sorting:** Suffix \`sa\` (ascending) or \`sd\` (descending). (eg \`10d6sd\`).
		- **Keep/Drop:** Use \`kh[n]\` to keep highest or \`kl[n]\` to keep lowest. (eg \`2d20kh1\` for Advantage).
		- **Rerolls:** Use \`r<[n]\` or \`r>[n]\` to automatically reroll specific values. (eg \`1d10r<3\`).
		- **Exploding Dice:** Suffix \`!\` to reroll and add any maximum results (eg \`4d6!\`).
		- **Successes:** Suffix \`>[n]\` to count how many dice hit a target (eg \`5d10>7\`).
		- **Private Rolls:** Prefix with \`private\` to receive results in your DMs.
		`);
	}

	async sendSupport(message) {
		await message.reply(
			`## Support AutoDice\n AutoDice is developed and provided free of charge, but your financial support is greatly appreciated to allow sustainable development and to cover costs. You can support me via https://vale.rocks/support. Thank you so very much!`,
		);
	}
}

new DiceBot().start();
