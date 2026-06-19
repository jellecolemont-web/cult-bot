const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const pool = require('../database');

const DEFAULT_WAGER = 20;
const CHALLENGE_TIMEOUT_MS = 60 * 1000;
const MAX_TURNS = 6;
const START_HEALTH = 100;

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS duel_stats (
      user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      gold_won INTEGER DEFAULT 0,
      gold_lost INTEGER DEFAULT 0,
      PRIMARY KEY (user_id, guild_id)
    )
  `);
  // Duplicated here (also created by cult.js/work.js) in case this file loads first
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallets (
      user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      balance INTEGER DEFAULT 0,
      last_work TIMESTAMPTZ,
      PRIMARY KEY (user_id, guild_id)
    )
  `);
}
initDB().catch(err => console.error('❌ Duel DB init error:', err));

// ── Wallet helpers ────────────────────────────────────────────────────────────
async function getBalance(userId, guildId) {
  const { rows } = await pool.query(`SELECT balance FROM wallets WHERE user_id = $1 AND guild_id = $2`, [userId, guildId]);
  return rows[0]?.balance || 0;
}

async function adjustBalance(userId, guildId, delta) {
  await pool.query(`
    INSERT INTO wallets (user_id, guild_id, balance)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, guild_id)
    DO UPDATE SET balance = wallets.balance + $3
  `, [userId, guildId, delta]);
}

async function recordResult(winnerId, loserId, guildId, wager) {
  await pool.query(`
    INSERT INTO duel_stats (user_id, guild_id, wins, gold_won)
    VALUES ($1, $2, 1, $3)
    ON CONFLICT (user_id, guild_id) DO UPDATE SET wins = duel_stats.wins + 1, gold_won = duel_stats.gold_won + $3
  `, [winnerId, guildId, wager]);

  await pool.query(`
    INSERT INTO duel_stats (user_id, guild_id, losses, gold_lost)
    VALUES ($1, $2, 1, $3)
    ON CONFLICT (user_id, guild_id) DO UPDATE SET losses = duel_stats.losses + 1, gold_lost = duel_stats.gold_lost + $3
  `, [loserId, guildId, wager]);
}

// ── Combat simulation ─────────────────────────────────────────────────────────
const ATTACK_LINES = [
  "{a} hurls a cursed candle at {b}, dealing {dmg} damage!",
  "{a} brands {b} a heretic in front of everyone, dealing {dmg} damage!",
  "{a} unleashes a swarm of locusts on {b}, dealing {dmg} damage!",
  "{a} reads {b}'s name from the forbidden scroll, dealing {dmg} damage!",
  "{a} slams the ritual gavel on {b}'s head, dealing {dmg} damage!",
  "{a} exposes {b}'s secret allegiance to a rival cult, dealing {dmg} damage!",
  "{a} hexes {b} with a voodoo doll, dealing {dmg} damage!",
  "{a} dumps a bowl of ceremonial ash on {b}, dealing {dmg} damage!",
];
const HEAL_LINES = [
  "{a} chants a healing incantation, regaining {heal} health!",
  "{a} drinks a vial of sacrificial wine, regaining {heal} health!",
  "{a} is blessed by the cult elders, regaining {heal} health!",
  "{a} lights a protective ward, regaining {heal} health!",
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function simulateDuel(nameA, nameB) {
  let hpA = START_HEALTH, hpB = START_HEALTH;
  const log = [];
  let attackerIsA = Math.random() < 0.5;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    if (hpA <= 0 || hpB <= 0) break;

    const attackerName = attackerIsA ? nameA : nameB;
    const defenderName = attackerIsA ? nameB : nameA;
    const isHeal = Math.random() < 0.25;

    if (isHeal) {
      const heal = 5 + Math.floor(Math.random() * 11); // 5-15
      if (attackerIsA) hpA = Math.min(START_HEALTH, hpA + heal); else hpB = Math.min(START_HEALTH, hpB + heal);
      log.push(pick(HEAL_LINES).replace('{a}', `**${attackerName}**`).replace('{heal}', `**+${heal}**`));
    } else {
      const dmg = 10 + Math.floor(Math.random() * 21); // 10-30
      if (attackerIsA) hpB = Math.max(0, hpB - dmg); else hpA = Math.max(0, hpA - dmg);
      log.push(pick(ATTACK_LINES).replace('{a}', `**${attackerName}**`).replace('{b}', `**${defenderName}**`).replace('{dmg}', `**-${dmg}**`));
    }

    attackerIsA = !attackerIsA;
  }

  const aWins = hpA === hpB ? Math.random() < 0.5 : hpA > hpB;
  return { log, hpA: Math.max(hpA, 0), hpB: Math.max(hpB, 0), aWins };
}

function healthBar(hp, max = START_HEALTH, length = 12) {
  const filled = Math.max(0, Math.min(length, Math.round((hp / max) * length)));
  return '█'.repeat(filled) + '░'.repeat(length - filled);
}

// ── Canvas rendering ──────────────────────────────────────────────────────────
// Note: emoji glyphs render inconsistently depending on which fonts happen to
// be installed on the host, so the trophy/tombstone are hand-drawn vector
// shapes instead of emoji text — guarantees they always look right regardless
// of server environment.
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawTrophy(ctx, cx, topY) {
  ctx.save();
  ctx.fillStyle = '#ffd60a';
  ctx.beginPath();
  ctx.moveTo(cx - 18, topY);
  ctx.quadraticCurveTo(cx, topY + 28, cx + 18, topY);
  ctx.lineTo(cx + 14, topY);
  ctx.quadraticCurveTo(cx, topY + 18, cx - 14, topY);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(cx - 3, topY + 18, 6, 8);
  ctx.fillRect(cx - 10, topY + 26, 20, 5);
  ctx.restore();
}

function drawTombstone(ctx, cx, topY) {
  ctx.save();
  ctx.fillStyle = '#9ca3af';
  ctx.beginPath();
  ctx.moveTo(cx - 16, topY + 30);
  ctx.lineTo(cx - 16, topY + 10);
  ctx.arc(cx, topY + 10, 16, Math.PI, 0);
  ctx.lineTo(cx + 16, topY + 30);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#374151';
  ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('RIP', cx, topY + 25);
  ctx.restore();
}

async function renderDuelImage(userA, userB, aWins) {
  const width = 760, height = 340;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, '#3a0ca3');
  bg.addColorStop(1, '#7209b7');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  const confettiColors = ['#ff595e', '#ffca3a', '#8ac926', '#1982c4', '#6a4c93', '#ffffff'];
  for (let i = 0; i < 90; i++) {
    ctx.save();
    ctx.translate(Math.random() * width, Math.random() * height);
    ctx.rotate(Math.random() * Math.PI);
    ctx.fillStyle = confettiColors[Math.floor(Math.random() * confettiColors.length)];
    ctx.fillRect(-3, -6, 6, 12);
    ctx.restore();
  }

  const panelY = 20, panelH = height - 80, panelW = width / 2 - 30;

  async function drawSide(x, user, isWinner) {
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    roundRect(ctx, x, panelY, panelW, panelH, 16);
    ctx.fill();

    const avatarSize = 150;
    const avatarX = x + panelW / 2 - avatarSize / 2;
    const avatarY = panelY + 35;

    try {
      const avatarImg = await loadImage(user.avatarURL);
      ctx.save();
      ctx.beginPath();
      ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(avatarImg, avatarX, avatarY, avatarSize, avatarSize);
      ctx.restore();
    } catch (err) {
      console.error('Avatar load failed:', err.message);
    }

    ctx.lineWidth = 6;
    ctx.strokeStyle = isWinner ? '#ffd60a' : '#6c757d';
    ctx.beginPath();
    ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(user.name.slice(0, 18), x + panelW / 2, avatarY + avatarSize + 35);

    if (isWinner) drawTrophy(ctx, x + panelW / 2, avatarY - 25);
    else drawTombstone(ctx, x + panelW / 2, avatarY - 30);
  }

  await drawSide(15, userA, aWins);
  await drawSide(width / 2 + 15, userB, !aWins);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 48px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('VS', width / 2, height / 2 + 15);

  return canvas.toBuffer('image/png');
}

// ── Command ──────────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('cultfight')
    .setDescription('Challenge another member to a duel for gold')
    .addUserOption(opt => opt.setName('opponent').setDescription('Who are you challenging?').setRequired(true))
    .addIntegerOption(opt => opt.setName('wager').setDescription(`Gold to wager (default ${DEFAULT_WAGER}, 0 for a friendly duel)`).setRequired(false).setMinValue(0)),

  async execute(interaction, client) {
    const guildId = interaction.guild.id;
    const challenger = interaction.user;
    const opponent = interaction.options.getUser('opponent');
    const wager = interaction.options.getInteger('wager') ?? DEFAULT_WAGER;

    if (opponent.id === challenger.id) return interaction.reply({ content: "⚠️ You can't duel yourself!", flags: 64 });
    if (opponent.bot) return interaction.reply({ content: "⚠️ You can't duel a bot!", flags: 64 });

    if (wager > 0) {
      const challengerBalance = await getBalance(challenger.id, guildId);
      if (challengerBalance < wager) {
        return interaction.reply({ content: `⚠️ You don't have **${wager}** gold to wager! Use /work to earn some.`, flags: 64 });
      }
      const opponentBalance = await getBalance(opponent.id, guildId);
      if (opponentBalance < wager) {
        return interaction.reply({ content: `⚠️ <@${opponent.id}> doesn't have enough gold to match that wager.`, flags: 64 });
      }
    }

    const acceptRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`duel_accept_${interaction.id}`).setLabel('Accept').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`duel_decline_${interaction.id}`).setLabel('Decline').setStyle(ButtonStyle.Danger),
    );

    await interaction.reply({
      content: `<@${opponent.id}>`,
      embeds: [new EmbedBuilder()
        .setTitle('⚔️ Cult Fight Challenge!')
        .setColor(0x6C63FF)
        .setDescription(`**${challenger.username}** has challenged **${opponent.username}** to a cult fight${wager > 0 ? ` for **${wager}** gold` : ''}!\n\nDo you accept?`)],
      components: [acceptRow]
    });

    const promptMsg = await interaction.fetchReply();
    let response;
    try {
      response = await promptMsg.awaitMessageComponent({
        filter: i => i.user.id === opponent.id && i.customId.endsWith(`_${interaction.id}`),
        time: CHALLENGE_TIMEOUT_MS
      });
    } catch {
      return interaction.editReply({
        content: null,
        embeds: [new EmbedBuilder().setColor(0x6C63FF).setDescription(`⌛ **${opponent.username}** didn't respond in time. Challenge expired.`)],
        components: []
      });
    }

    if (response.customId.includes('decline')) {
      return response.update({
        content: null,
        embeds: [new EmbedBuilder().setColor(0xff0000).setDescription(`❌ **${opponent.username}** declined the duel.`)],
        components: []
      });
    }

    await response.update({
      content: null,
      embeds: [new EmbedBuilder().setColor(0x6C63FF).setDescription(`⚔️ **${opponent.username}** accepted! Let the duel begin...`)],
      components: []
    });

    if (wager > 0) {
      const challengerBalance = await getBalance(challenger.id, guildId);
      const opponentBalance = await getBalance(opponent.id, guildId);
      if (challengerBalance < wager || opponentBalance < wager) {
        return interaction.followUp({ content: '⚠️ One of you no longer has enough gold to cover the wager. Duel cancelled.' });
      }
      await adjustBalance(challenger.id, guildId, -wager);
      await adjustBalance(opponent.id, guildId, -wager);
    }

    const { log, hpA, hpB, aWins } = simulateDuel(challenger.username, opponent.username);
    const winner = aWins ? challenger : opponent;
    const loser = aWins ? opponent : challenger;
    const winnerHp = aWins ? hpA : hpB;
    const loserHp = aWins ? hpB : hpA;

    await recordResult(winner.id, loser.id, guildId, wager);
    if (wager > 0) await adjustBalance(winner.id, guildId, wager * 2);

    const imageBuffer = await renderDuelImage(
      { name: challenger.username, avatarURL: challenger.displayAvatarURL({ extension: 'png', size: 256 }) },
      { name: opponent.username, avatarURL: opponent.displayAvatarURL({ extension: 'png', size: 256 }) },
      aWins
    );
    const attachment = new AttachmentBuilder(imageBuffer, { name: 'duel.png' });

    const embed = new EmbedBuilder()
      .setTitle(`🏆 Victory! ${winner.username} was victorious!`)
      .setColor(0xffd700)
      .setImage('attachment://duel.png')
      .setDescription(log.map(l => `• ${l}`).join('\n'))
      .addFields(
        { name: `🏆 ${winner.username}`, value: `${healthBar(winnerHp)} ${winnerHp}%`, inline: true },
        { name: `💀 ${loser.username}`, value: `${healthBar(loserHp)} ${loserHp}%`, inline: true },
      );

    if (wager > 0) embed.addFields({ name: '💰 Pot Won', value: `${wager * 2} gold` });

    return interaction.followUp({ embeds: [embed], files: [attachment] });
  }
};