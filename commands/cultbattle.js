const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const pool = require('../database');

// ── Shared helpers (duplicated from cult.js since commands are separate files) ─
async function getCultByRole(guildId, roleId) {
  const { rows } = await pool.query(`SELECT * FROM cults WHERE guild_id = $1 AND role_id = $2`, [guildId, roleId]);
  return rows[0] || null;
}

async function getCultRoster(cult) {
  const { rows } = await pool.query(`SELECT * FROM cult_members WHERE cult_id = $1`, [cult.id]);
  return rows.map(m => ({ ...m, rank: m.user_id === cult.leader_id ? 'leader' : m.rank }));
}

async function syncMembers(guild, cult) {
  const role = guild.roles.cache.get(cult.role_id);
  if (!role) return;
  try { await guild.members.fetch({ force: false }); } catch {}
  for (const [memberId] of role.members) {
    await pool.query(`
      INSERT INTO cult_members (user_id, guild_id, cult_id, region)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, guild_id) DO NOTHING
    `, [memberId, guild.id, cult.id, hashRegion(memberId)]);
  }
}

function hashRegion(userId) {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return ['north', 'south', 'east', 'west'][hash % 4];
}

const RANK_POWER = { leader: 4, coleader: 3, general: 2, soldier: 1, recruit: 0 };
const STANCE_POWER_MULTIPLIER = { aggressive: 1.2, balanced: 1.0, defensive: 0.9 };
const STANCE_LABEL = { aggressive: '⚔️ Aggressive', balanced: '⚖️ Balanced', defensive: '🛡️ Defensive' };
const REGION_LABEL = { north: '⬆️ North', south: '⬇️ South', east: '➡️ East', west: '⬅️ West' };

function calcFighterPower(roster) {
  return roster.filter(m => m.is_alive).reduce((sum, m) => sum + (RANK_POWER[m.rank] || 0), 0);
}

function calcRoundPower(cult, fighterPower, stance) {
  const weaponBonus = 1 + (cult.weapon_level - 1) * 0.1;
  const stanceMult = STANCE_POWER_MULTIPLIER[stance] ?? 1.0;
  const base = fighterPower * 10 * weaponBonus * stanceMult;
  return Math.floor(base * (0.8 + Math.random() * 0.4));
}

const START_HEALTH = 100;

const ATTACK_LINES = [
  "{a} sends a wave of soldiers charging {b}'s gates, dealing {dmg} damage!",
  "{a} sets fire to {b}'s supply tents, dealing {dmg} damage!",
  "{a} ambushes {b}'s scouts in the night, dealing {dmg} damage!",
  "{a} breaches {b}'s defenses with a battering ram, dealing {dmg} damage!",
  "{a} rains arrows down on {b}'s ranks, dealing {dmg} damage!",
  "{a} poisons {b}'s well, dealing {dmg} damage!",
  "{a} unleashes their General on {b}'s frontline, dealing {dmg} damage!",
  "{a} sabotages {b}'s war drums, dealing {dmg} damage!",
];
const HEAL_LINES = [
  "{a} rallies their troops with a fiery speech, regaining {heal} health!",
  "{a}'s healers patch up the wounded, regaining {heal} health!",
  "{a} digs in and reinforces the walls, regaining {heal} health!",
  "{a} receives emergency supplies, regaining {heal} health!",
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function healthBar(hp, max = START_HEALTH, length = 12) {
  const filled = Math.max(0, Math.min(length, Math.round((hp / max) * length)));
  return '█'.repeat(filled) + '░'.repeat(length - filled);
}

// ── Canvas rendering (duplicated pattern from catfight.js) ──────────────────
function intToHex(colorInt) {
  if (!colorInt) return '#5865F2'; // Discord blurple fallback for roles with no color set
  return '#' + colorInt.toString(16).padStart(6, '0');
}

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

async function renderCultBattleImage(sideA, sideB, aWins) {
  const width = 760, height = 340;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, sideA.color);
  bg.addColorStop(1, sideB.color);
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

  async function drawSide(x, side, isWinner) {
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    roundRect(ctx, x, panelY, panelW, panelH, 16);
    ctx.fill();

    const avatarSize = 150;
    const avatarX = x + panelW / 2 - avatarSize / 2;
    const avatarY = panelY + 35;

    try {
      const avatarImg = await loadImage(side.avatarURL);
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
    ctx.fillText(side.name.slice(0, 20), x + panelW / 2, avatarY + avatarSize + 35);

    ctx.font = '14px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText('Cult Leader', x + panelW / 2, avatarY + avatarSize + 55);

    if (isWinner) drawTrophy(ctx, x + panelW / 2, avatarY - 25);
    else drawTombstone(ctx, x + panelW / 2, avatarY - 30);
  }

  await drawSide(15, sideA, aWins);
  await drawSide(width / 2 + 15, sideB, !aWins);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 48px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('VS', width / 2, height / 2 + 15);

  return canvas.toBuffer('image/png');
}

// ── Command ──────────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('cultbattle')
    .setDescription('Start a cult vs cult battle — winning cult members get a reward role (Admin only)')
    .addRoleOption(opt => opt.setName('cult1').setDescription('First cult role').setRequired(true))
    .addRoleOption(opt => opt.setName('cult2').setDescription('Second cult role').setRequired(true))
    .addRoleOption(opt => opt.setName('reward').setDescription('Role given to every member of the winning cult').setRequired(true))
    .addStringOption(opt =>
      opt.setName('direction')
        .setDescription('Which region of cult2 to attack')
        .setRequired(true)
        .addChoices(
          { name: '⬆️ North', value: 'north' },
          { name: '⬇️ South', value: 'south' },
          { name: '➡️ East', value: 'east' },
          { name: '⬅️ West', value: 'west' },
        )
    ),

  async execute(interaction, client) {
    if (!interaction.member.permissions.has('ModerateMembers')) {
      return interaction.reply({ content: '⚠️ Only moderators can start a cult battle.', flags: 64 });
    }

    const guild = interaction.guild;
    const cult1Role = interaction.options.getRole('cult1');
    const cult2Role = interaction.options.getRole('cult2');
    const rewardRole = interaction.options.getRole('reward');
    const direction = interaction.options.getString('direction');

    if (cult1Role.id === cult2Role.id) return interaction.reply({ content: '⚠️ Choose two different cults!', flags: 64 });

    const cult1 = await getCultByRole(guild.id, cult1Role.id);
    const cult2 = await getCultByRole(guild.id, cult2Role.id);
    if (!cult1) return interaction.reply({ content: `⚠️ <@&${cult1Role.id}> is not a registered cult!`, flags: 64 });
    if (!cult2) return interaction.reply({ content: `⚠️ <@&${cult2Role.id}> is not a registered cult!`, flags: 64 });

    await syncMembers(guild, cult1);
    await syncMembers(guild, cult2);

    const roster1 = await getCultRoster(cult1);
    const roster2 = await getCultRoster(cult2);

    const power1 = calcFighterPower(roster1);
    const power2Region = calcFighterPower(roster2.filter(m => m.region === direction));
    const power2Total = calcFighterPower(roster2);

    if (power1 === 0) return interaction.reply({ content: `⚠️ **${cult1.name}** has no fighters!`, flags: 64 });
    if (power2Total === 0) return interaction.reply({ content: `⚠️ **${cult2.name}** has no fighters!`, flags: 64 });

    // Stance picker for cult1 (the attacker)
    const stanceRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cb_aggressive_${interaction.id}`).setLabel('Aggressive').setEmoji('⚔️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`cb_balanced_${interaction.id}`).setLabel('Balanced').setEmoji('⚖️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`cb_defensive_${interaction.id}`).setLabel('Defensive').setEmoji('🛡️').setStyle(ButtonStyle.Primary),
    );

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('⚔️ Cult Battle!')
        .setColor(0x6C63FF)
        .setDescription(
          `**${cult1.name}** <@&${cult1Role.id}> ⚔️ **${cult2.name}** <@&${cult2Role.id}>\n\n` +
          `🎯 Attacking **${REGION_LABEL[direction]}** region of **${cult2.name}**\n` +
          `🏆 Reward: <@&${rewardRole.id}> for every member of the winning cult\n\n` +
          `Choose your attack stance (30s, defaults to Balanced):`
        )],
      components: [stanceRow]
    });

    const promptMsg = await interaction.fetchReply();
    let stance1 = 'balanced';

    try {
      const click = await promptMsg.awaitMessageComponent({
        filter: i => i.customId.endsWith(`_${interaction.id}`) && i.user.id === interaction.user.id,
        time: 30000
      });
      stance1 = click.customId.split('_')[1];
      await click.update({
        embeds: [new EmbedBuilder().setColor(0x6C63FF).setDescription(`**${cult1.name}** picks **${STANCE_LABEL[stance1]}** and marches in!`)],
        components: []
      });
    } catch {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0x6C63FF).setDescription(`No stance chosen — **${cult1.name}** marches in with **${STANCE_LABEL.balanced}**.`)],
        components: []
      });
    }

    const stance2 = cult2.war_stance || 'balanced';

    // ── HP-based turn battle ──
    // Each side's max HP scales with fighter power, so a bigger/stronger cult
    // can absorb more hits — member count and rank weighting both matter here.
    const maxHp1 = START_HEALTH + power1 * 5;
    const maxHp2 = START_HEALTH + power2Region * 5;
    let hp1 = maxHp1, hp2 = maxHp2;

    const MAX_TURNS = 60; // safety cap only — battles almost always finish naturally well before this
    let attackerIs1 = Math.random() < 0.5;
    const turnLog = [];

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      if (hp1 <= 0 || hp2 <= 0) break;

      const attackerName = attackerIs1 ? cult1.name : cult2.name;
      const defenderName = attackerIs1 ? cult2.name : cult1.name;
      const attackerCultObj = attackerIs1 ? cult1 : cult2;
      const attackerPower = attackerIs1 ? power1 : power2Region;
      const attackerStance = attackerIs1 ? stance1 : stance2;
      const isHeal = Math.random() < 0.2;

      if (isHeal) {
        const heal = 8 + Math.floor(Math.random() * 13); // 8-20
        if (attackerIs1) hp1 = Math.min(maxHp1, hp1 + heal); else hp2 = Math.min(maxHp2, hp2 + heal);
        turnLog.push(pick(HEAL_LINES).replace('{a}', `**${attackerName}**`).replace('{heal}', `**+${heal}**`));
      } else {
        const raw = calcRoundPower(attackerCultObj, attackerPower, attackerStance);
        const dmg = Math.max(5, Math.floor(raw / 8)); // scale the power roll down into a per-turn HP chunk
        if (attackerIs1) hp2 = Math.max(0, hp2 - dmg); else hp1 = Math.max(0, hp1 - dmg);
        turnLog.push(pick(ATTACK_LINES).replace('{a}', `**${attackerName}**`).replace('{b}', `**${defenderName}**`).replace('{dmg}', `**-${dmg}**`));
      }

      attackerIs1 = !attackerIs1;
    }

    // Safety net: if healing kept both sides alive past the turn cap (rare),
    // force a decisive finish so a battle never ends without a clear loser.
    if (hp1 > 0 && hp2 > 0) {
      if (hp1 <= hp2) {
        turnLog.push(`💀 After a brutal war of attrition, **${cult1.name}**'s forces finally collapse!`);
        hp1 = 0;
      } else {
        turnLog.push(`💀 After a brutal war of attrition, **${cult2.name}**'s forces finally collapse!`);
        hp2 = 0;
      }
    }

    const cult1Wins = hp2 <= 0;
    const winnerCult = cult1Wins ? cult1 : cult2;
    const winnerRole = cult1Wins ? cult1Role : cult2Role;
    const winnerRoster = cult1Wins ? roster1 : roster2;
    const finalHp1 = Math.max(hp1, 0), finalHp2 = Math.max(hp2, 0);

    // Discord embed descriptions cap at 4096 chars — long wars can run many
    // turns, so only show the most recent stretch if the log gets long.
    const DISPLAY_TURN_LIMIT = 20;
    const displayedTurns = turnLog.length > DISPLAY_TURN_LIMIT
      ? turnLog.slice(-DISPLAY_TURN_LIMIT)
      : turnLog;
    const omittedCount = turnLog.length - displayedTurns.length;
    const logHeader = omittedCount > 0 ? `*(showing the final ${DISPLAY_TURN_LIMIT} of ${turnLog.length} exchanges)*\n\n` : '';

    // Post the battle log
    await interaction.followUp({
      embeds: [new EmbedBuilder()
        .setTitle('⚔️ Cult Battle in Progress...')
        .setColor(0x6C63FF)
        .setDescription(logHeader + displayedTurns.map(l => `• ${l}`).join('\n'))
        .addFields(
          { name: `${cult1.name}`, value: `${healthBar(finalHp1, maxHp1)} ${Math.round((finalHp1 / maxHp1) * 100)}%`, inline: true },
          { name: `${cult2.name}`, value: `${healthBar(finalHp2, maxHp2)} ${Math.round((finalHp2 / maxHp2) * 100)}%`, inline: true },
        )]
    });

    // Give reward role to every member of the winning cult
    try {
      await guild.members.fetch({ force: false });
    } catch (err) {
      console.error('Member fetch failed before role assignment:', err.message);
    }
    const rewarded = [];
    const failed = [];

    for (const member of winnerRoster) {
      try {
        const guildMember = guild.members.cache.get(member.user_id);
        if (guildMember) {
          await guildMember.roles.add(rewardRole.id);
          rewarded.push(member.user_id);
        } else {
          failed.push(member.user_id);
        }
      } catch (err) {
        console.error(`Failed to assign reward role to ${member.user_id}:`, err.message);
        failed.push(member.user_id);
      }
    }

    const rewardedMentions = rewarded.map(id => `<@${id}>`).join(' ') || '*Nobody*';

    const resultFields = [
      { name: `🏆 Winner`, value: `**${winnerCult.name}** <@&${winnerRole.id}>` },
      { name: `🎁 Rewarded members (${rewarded.length})`, value: rewardedMentions.slice(0, 1000) },
    ];
    if (failed.length > 0) {
      resultFields.push({ name: '⚠️ Not rewarded', value: `${failed.length} member(s) couldn't receive the role (may have left the server, or the bot's role is positioned below the reward role)` });
    }

    // Build the VS image using each cult's Leader as the "face" of their cult
    let leader1User, leader2User;
    try { leader1User = await client.users.fetch(cult1.leader_id); } catch (err) { console.error('Leader1 fetch failed:', err.message); }
    try { leader2User = await client.users.fetch(cult2.leader_id); } catch (err) { console.error('Leader2 fetch failed:', err.message); }

    const fallbackAvatar = 'https://cdn.discordapp.com/embed/avatars/0.png';
    const sideA = {
      name: cult1.name,
      avatarURL: leader1User ? leader1User.displayAvatarURL({ extension: 'png', size: 256 }) : fallbackAvatar,
      color: intToHex(cult1Role.color),
    };
    const sideB = {
      name: cult2.name,
      avatarURL: leader2User ? leader2User.displayAvatarURL({ extension: 'png', size: 256 }) : fallbackAvatar,
      color: intToHex(cult2Role.color),
    };

    let attachment = null;
    try {
      const imageBuffer = await renderCultBattleImage(sideA, sideB, cult1Wins);
      attachment = new AttachmentBuilder(imageBuffer, { name: 'cultbattle.png' });
    } catch (err) {
      console.error('Failed to render cult battle image:', err.message);
    }

    const resultEmbed = new EmbedBuilder()
      .setTitle(`🏆 ${winnerCult.name} wins the Cult Battle!`)
      .setColor(0xffd700)
      .setDescription(
        `<@&${cult1Role.id}> **vs** <@&${cult2Role.id}>\n` +
        `🎯 Attack: ${REGION_LABEL[direction]} of **${cult2.name}** (${STANCE_LABEL[stance2]})\n\n` +
        `**Final HP:**\n` +
        `${cult1.name}: ${healthBar(finalHp1, maxHp1)} ${Math.round((finalHp1 / maxHp1) * 100)}%\n` +
        `${cult2.name}: ${healthBar(finalHp2, maxHp2)} ${Math.round((finalHp2 / maxHp2) * 100)}%`
      )
      .addFields(...resultFields)
      .setTimestamp();

    if (attachment) resultEmbed.setImage('attachment://cultbattle.png');

    await interaction.followUp({
      embeds: [resultEmbed],
      files: attachment ? [attachment] : []
    });
  }
};