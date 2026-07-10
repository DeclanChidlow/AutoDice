const API_BASE = process.env.STOAT_API_URL || "https://api.stoat.chat/0.8";
const BOT_TOKEN = process.env.BOT_TOKEN;
const MAX_CHARS = parseInt(process.env.STOAT_MAX_CHARS) || 2000;
const VERBOSE = process.env.VERBOSE_LOGGING === "true" || process.env.VERBOSE_LOGGING === "1";

if (!BOT_TOKEN) {
	console.error("Fatal: BOT_TOKEN is not set. Add it to your .env file.");
	process.exit(1);
}

function verboseLog(...args) {
	if (VERBOSE) console.log(...args);
}

class AutoDice {
	constructor() {
		this.user = null;
		this.users = new Map();
		this.config = null;
		this.ws = null;
		this.wsPing = -1;
		this.heartbeatTimer = null;
		this.pongTimer = null;
		this.reconnectTimer = null;
		this.reconnectAttempts = 0;
		this._lastMsgId = null;
	}

	async api(method, path, body) {
		const url = new URL(path, API_BASE);
		const opts = {
			method,
			headers: { "X-Bot-Token": BOT_TOKEN },
		};
		if (body != null) {
			opts.headers["Content-Type"] = "application/json";
			opts.body = JSON.stringify(body);
		}
		const res = await fetch(url, opts);
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`API ${method} ${path} → ${res.status}: ${text}`);
		}
		if (res.status === 204) return null;
		return res.json();
	}

	async apiGet(path) {
		return this.api("GET", path);
	}
	async apiPost(path, body) {
		return this.api("POST", path, body);
	}
	async apiPatch(path, body) {
		return this.api("PATCH", path, body);
	}

	connectWS() {
		if (!this.config?.ws) {
			console.error("No WebSocket URL in config");
			return;
		}

		this.disconnectWS(false);

		const url = new URL(this.config.ws);
		url.searchParams.set("version", "1");
		url.searchParams.set("format", "json");
		url.searchParams.set("token", BOT_TOKEN);

		verboseLog(`Connecting to ${url.origin}${url.pathname}...`);

		this.ws = new WebSocket(url);
		this.wsPing = -1;

		this.ws.onopen = () => {
			this.heartbeatTimer = setInterval(() => {
				this.sendWS({ type: "Ping", data: Date.now() });
				this.pongTimer = setTimeout(() => {
					verboseLog("WebSocket pong timeout");
					this.ws?.close();
				}, 10_000);
			}, 30_000);
		};

		this.ws.onmessage = (event) => {
			let msg;
			try {
				msg = JSON.parse(event.data);
			} catch (e) {
				console.error("WebSocket: invalid JSON frame:", e);
				return;
			}
			this.handleWSEvent(msg);
		};

		this.ws.onerror = (err) => {
			console.error("WebSocket error:", err);
		};

		this.ws.onclose = () => {
			verboseLog("WebSocket disconnected");
			this.disconnectWS(true);
		};
	}

	disconnectWS(reconnect) {
		clearInterval(this.heartbeatTimer);
		clearTimeout(this.pongTimer);
		this.heartbeatTimer = null;
		this.pongTimer = null;
		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
		if (this.ws) {
			this.ws.onopen = null;
			this.ws.onmessage = null;
			this.ws.onerror = null;
			this.ws.onclose = null;
			try {
				this.ws.close();
			} catch (_) {}
			this.ws = null;
		}
		if (reconnect) {
			this.scheduleReconnect();
		}
	}

	sendWS(data) {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(data));
		}
	}

	scheduleReconnect() {
		clearTimeout(this.reconnectTimer);
		const base = Math.pow(2, Math.min(this.reconnectAttempts, 10)) - 1;
		const delay = base * (0.8 + Math.random() * 0.4);
		this.reconnectAttempts++;
		verboseLog(`Reconnecting in ${Math.round(delay)}s (attempt ${this.reconnectAttempts})`);
		this.reconnectTimer = setTimeout(() => this.connectWS(), delay * 1000);
	}

	handleWSEvent(event) {
		switch (event.type) {
			case "Ping":
				this.sendWS({ type: "Pong", data: event.data });
				return;
			case "Pong":
				clearTimeout(this.pongTimer);
				this.wsPing = Date.now() - event.data;
				return;
			case "Error":
				console.error("Server error event:", event.data);
				this.disconnectWS(true);
				return;
			case "Authenticated":
				return;
			case "Ready":
				this.handleReady(event);
				return;
			case "Message":
				this.handleMessageEvent(event);
				return;
		}
	}

	handleReady(event) {
		this.reconnectAttempts = 0;
		this._lastMsgId = null;

		if (event.users) {
			for (const u of event.users) {
				this.users.set(u._id, { id: u._id, username: u.username, bot: u.bot ?? null });
				if (u.relationship === "User") {
					this.user = { id: u._id, username: u.username };
				}
			}
		}

		console.log(`AutoDice ready as ${this.user?.username} (${this.user?.id})`);

		this.setStatus();
	}

	handleMessageEvent(event) {
		if (this._lastMsgId === event._id) return;
		this._lastMsgId = event._id;

		const authorId = event.author;
		let author = this.users.get(authorId);
		if (!author && event.user) {
			author = { id: event.user._id, username: event.user.username, bot: event.user.bot ?? null };
			this.users.set(author.id, author);
		}

		const content = event.content ?? "";

		const message = {
			id: event._id,
			authorId: authorId,
			author: author || null,
			channelId: event.channel,
			content: content,
			reply: (data) => this.sendReply(event.channel, event._id, data),
			edit: (data) => this.editMessage(event.channel, event._id, data),
		};

		this.handleMessage(message).catch((err) => {
			console.error("handleMessage error:", err);
		});
	}

	async sendReply(channelId, replyToId, data) {
		const body = typeof data === "string" ? { content: data } : { ...data };
		body.replies = [{ id: replyToId, mention: true }];
		const result = await this.apiPost(`/channels/${channelId}/messages`, body);
		return this.makeMessage(channelId, result);
	}

	async editMessage(channelId, messageId, data) {
		const body = typeof data === "string" ? { content: data } : data;
		await this.apiPatch(`/channels/${channelId}/messages/${messageId}`, body);
	}

	makeMessage(channelId, raw) {
		const id = raw._id;
		return {
			id: id,
			channelId: channelId,
			authorId: raw.author,
			reply: (data) => this.sendReply(channelId, id, data),
			edit: (data) => this.editMessage(channelId, id, data),
		};
	}

	async getDMChannel(userId) {
		try {
			const data = await this.apiGet(`/users/${userId}/dm`);
			return data;
		} catch (error) {
			console.error("DM Channel Error:", error);
			return null;
		}
	}

	async sendDM(userId, content) {
		const dm = await this.getDMChannel(userId);
		if (!dm) return null;
		return this.apiPost(`/channels/${dm._id}/messages`, { content });
	}

	async handleMessage(message) {
		if (message.author?.bot || !message.content) return;

		let content = message.content.trim();
		const botMention = `<@${this.user?.id}>`;

		if (!content.startsWith(botMention)) return;

		content = content.slice(botMention.length).trim();
		if (!content) {
			return await this.sendHelp(message);
		}

		if (content.includes(".")) {
			return await message.reply("⚠️ **Invalid Input:** Decimals are not supported. Please use whole numbers only.");
		}

		const args = content.split(/\s+/);
		const trigger = args[0].toLowerCase();

		if (trigger === "help") {
			return await this.sendHelp(message);
		}

		if (trigger === "support") {
			return await this.sendSupport(message);
		}

		if (trigger === "ping") {
			return await this.handlePing(message);
		}

		if (["adv", "advantage"].includes(trigger)) {
			args[0] = "2d20kh1";
		} else if (["dis", "disadvantage"].includes(trigger)) {
			args[0] = "2d20kl1";
		}

		let isDMRequest = false;
		if (["dm", "secret", "priv", "private"].includes(trigger)) {
			isDMRequest = true;
			args.shift();
		}

		// Extract dice formula + optional label
		const { formula, label } = this.extractFormula(args.join(" "));
		if (!formula) return;

		await this.processRoll(message, formula, isDMRequest, label);
	}

	async handlePing(message) {
		const now = Date.now();

		const wsDisplay = this.wsPing < 0 ? "`Reconnecting/Syncing…`" : `\`${this.wsPing}ms\``;

		const uptime = process.uptime();
		const d = Math.floor(uptime / 86400);
		const h = Math.floor((uptime % 86400) / 3600);
		const m = Math.floor((uptime % 3600) / 60);
		const s = Math.floor(uptime % 60);

		let uptimeStr = "";
		if (d > 0) uptimeStr += `${d}d `;
		if (h > 0) uptimeStr += `${h}h `;
		if (m > 0) uptimeStr += `${m}m `;
		if (uptime < 300) uptimeStr += `${s}s`;

		try {
			const msg = await message.reply("⌛ Measuring...");

			if (msg) {
				const messagePing = Math.round(Date.now() - now);
				const content = ["## Ping Pong!", `WebSocket: ${wsDisplay}`, `Message: \`${messagePing}ms\``, `Uptime: \`${uptimeStr.trim() || "0s"}\``].join("\n");

				await msg.edit({ content });
			}
		} catch (error) {
			console.error("Ping error:", error);
		}
	}

	extractFormula(input) {
		// Try progressively shorter prefixes to separate formula from label
		const parts = input.split(/\s+/);
		for (let i = parts.length; i >= 1; i--) {
			const candidate = parts.slice(0, i).join(" ");
			if (this.isDiceString(candidate)) {
				const label = parts.slice(i).join(" ") || null;
				return { formula: candidate, label };
			}
		}
		return { formula: null, label: null };
	}

	async processRoll(message, input, isPrivate, label) {
		const repeatMatch = input.match(/^(\d+)\s+(.*d.*)/i);
		let output = "";

		if (label) {
			output += `🎲 **${label}**\n`;
		}

		if (repeatMatch) {
			const count = parseInt(repeatMatch[1]);
			const formula = repeatMatch[2];
			output += `**Repeating ${count} times:** \`${formula}\`\n`;
			for (let i = 0; i < count; i++) {
				const res = this.calculateDice(formula);
				output += `${i + 1}. **${res.total}** \t${res.breakdown}\n`;
			}
		} else {
			const res = this.calculateDice(input);
			if (label) {
				output += `**${res.total}** — ${res.breakdown}`;
			} else {
				output += `🎲 **${res.total}**\n${res.breakdown}`;
			}
		}

		if (output.length > MAX_CHARS) {
			output = `⚠️ **Error:** The result is too long (${output.length} characters) to be sent.`;
		}

		if (isPrivate) {
			const sent = await this.sendDM(message.authorId, output);
			if (sent) {
				await message.reply("✅ Sent to DMs.");
			} else {
				await message.reply("❌ Unable to send a DM.");
			}
		} else {
			await message.reply(output);
		}
	}

	isDiceString(str) {
		if (!/d[\df%]/i.test(str)) return false;
		const withoutDice = str.replace(/(\d+)?d(\d+|[fF%])([a-z!<>=\d]*)/gi, "");
		return /^[0-9+\-*/()<>\s!]*$/i.test(withoutDice);
	}

	calculateDice(expression) {
		// Expand shorthands
		expression = expression.replace(/\bd%\b/gi, "d100");

		const diceRegex = /(\d+)?d(\d+|[fF%])([a-z!<>=\d]*)/gi;
		const rolls = [];

		const evalString = expression.replace(diceRegex, (match, countStr, sidesStr, mods) => {
			const count = Math.max(1, parseInt(countStr || "1"));

			// Fate/Fudge dice
			if (/^[fF]$/.test(sidesStr)) {
				const fateResults = [];
				for (let i = 0; i < count; i++) {
					const r = Math.floor(Math.random() * 3) - 1; // -1, 0, or 1
					const symbol = r === -1 ? "−" : r === 0 ? "▯" : "+";
					fateResults.push({ val: r, kept: true, symbol });
				}
				const sum = fateResults.reduce((a, d) => a + d.val, 0);
				const formatted = fateResults.map((d) => d.symbol).join(" ");
				rolls.push(`${match} (${formatted})`);
				return `(${sum})`;
			}

			const sides = parseInt(sidesStr);

			if (!(sides >= 1) || count < 1) {
				rolls.push(`${match} (0)`);
				return `(0)`;
			}

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
			const sanitized = evalString.replace(/[^0-9+\-*/().\s]/g, "");
			if (!sanitized) throw new Error("empty expression");
			total = new Function(`return ${sanitized}`)();
			if (typeof total === "number" && !Number.isInteger(total)) {
				total = Number(total.toFixed(2));
			}
		} catch (e) {
			total = "Error";
		}

		return { total, breakdown: rolls.join(" + ") };
	}

	applyModifiers(results, modStr, sides) {
		// Reroll (single pass)
		const rerollMatch = modStr.match(/r([<>=]?)(\d+)/);
		if (rerollMatch) {
			const op = rerollMatch[1] || "=";
			const target = parseInt(rerollMatch[2]);
			results.forEach((d) => {
				const trigger = (op === "=" && d.val === target) || (op === "<" && d.val < target) || (op === ">" && d.val > target);
				if (trigger) d.val = Math.floor(Math.random() * sides) + 1;
			});
		}

		// Success counting (>N)
		const successMatch = modStr.match(/>(\d+)/);
		if (successMatch) {
			const threshold = parseInt(successMatch[1]);
			results.forEach((d) => {
				d.kept = d.val >= threshold;
				d.val = d.val >= threshold ? 1 : 0;
			});
			return results;
		}

		// Fail counting (<N)
		const failMatch = modStr.match(/<(\d+)/);
		if (failMatch) {
			const threshold = parseInt(failMatch[1]);
			results.forEach((d) => {
				d.kept = d.val < threshold;
				d.val = d.val < threshold ? 1 : 0;
			});
			return results;
		}

		// Keep highest/lowest
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

		// Drop highest/lowest
		const dropMatch = modStr.match(/d([hl])(\d+)/);
		if (dropMatch) {
			const type = dropMatch[1];
			const num = parseInt(dropMatch[2]);
			const sorted = [...results].sort((a, b) => b.val - a.val);
			const toDrop = type === "h" ? sorted.slice(0, num) : sorted.slice(-num);
			results.forEach((d) => {
				if (toDrop.includes(d)) d.kept = false;
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

Visit [the website](<https://automod.vale.rocks/docs/autodice>) for more usage information and [the AutoMod server](https://stt.gg/automod) for help.

- **Basic Rolls:** \`@AutoDice [number]d[sides]\` (eg \`10d6\`). Use \`d%\` for percentile or \`dF\` for Fate dice.
- **Math:** Supports \`+\`, \`-\`, \`*\`, \`/\`. (eg \`1d20 + 5\`).
- **Advantage/Disadvantage:** Shorthand \`adv\` or \`dis\` (expands to \`2d20kh1\` / \`2d20kl1\`).
- **Sorting:** Suffix \`sa\` (ascending) or \`sd\` (descending). (eg \`10d6sd\`).
- **Keep/Drop:** \`kh[n]\` / \`kl[n]\` to keep highest/lowest, or \`dh[n]\` / \`dl[n]\` to drop them. (eg \`4d6dl1\`).
- **Rerolls:** \`r<[n]\` or \`r>[n]\` to reroll values below/above a threshold. (eg \`1d10r<3\`).
- **Exploding Dice:** Suffix \`!\` to reroll and add any maximum results (eg \`4d6!\`).
- **Successes/Failures:** \`>[n]\` to count dice meeting a target, \`<[n]\` to count those below. (eg \`5d10>7\`).
- **Labels:** Add text after your roll to label it. (eg \`1d20+5 Stealth check\`).
- **Private Rolls:** Prefix with \`private\` to receive results in your DMs.`);
	}

	async sendSupport(message) {
		await message.reply(
			`## Support AutoDice\n AutoDice is developed and provided free of charge, but your financial support is greatly appreciated to allow sustainable development and to cover costs. You can support me via https://vale.rocks/support. Thank you so very much!`,
		);
	}

	async setStatus() {
		if (!this.user) return;
		const text = `@${this.user.username} help`;
		try {
			await this.apiPatch("/users/@me", { status: { text } });
			verboseLog(`Status set to "${text}"`);
		} catch (error) {
			console.error("Failed to set status:", error);
		}
	}

	async start() {
		verboseLog("Fetching server config...");
		this.config = await this.apiGet("/");
		verboseLog(`Config loaded, ws=${this.config.ws}`);
		this.connectWS();
	}
}

new AutoDice().start().catch((err) => {
	console.error("Fatal startup error:", err);
	process.exit(1);
});
