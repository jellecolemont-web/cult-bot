const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Collection, REST, Routes } = require('discord.js');
require('dotenv').config();
const express = require('express');
const app = express();

app.get('/', (req, res) => res.send('Cult Bot online'));
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.commands = new Collection();

// Load commands
const commandsPath = path.join(__dirname, 'commands');
if (!fs.existsSync(commandsPath)) fs.mkdirSync(commandsPath);

function loadCommands(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      loadCommands(fullPath);
    } else if (file.endsWith('.js')) {
      try {
        const command = require(fullPath);
        if (command.data && typeof command.data.toJSON === 'function') {
          client.commands.set(command.data.name, command);
          console.log(`✔ Loaded: ${command.data.name}`);
        }
      } catch (err) {
        console.error(`❌ Failed to load ${fullPath}:`, err.message);
      }
    }
  }
}

loadCommands(commandsPath);

const rest = new REST({ version: '10' }).setToken(process.env.CULT_TOKEN);

client.once('clientReady', async () => {
  console.log(`⚔️ Cult Bot logged in as ${client.user.tag}`);

  try {
    const commandsJSON = Array.from(client.commands.values()).map(cmd => cmd.data.toJSON());
    if (!process.env.CULT_CLIENT_ID) return console.warn('CULT_CLIENT_ID not set');

    // Deploy globally
    await rest.put(
      Routes.applicationCommands(process.env.CULT_CLIENT_ID),
      { body: commandsJSON }
    );
    console.log('✅ Cult commands deployed globally.');
  } catch (err) {
    console.error('Failed to deploy commands:', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction, client);
  } catch (error) {
    console.error(error);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: '❌ Something went wrong.', flags: 64 });
      } else {
        await interaction.reply({ content: '❌ Something went wrong.', flags: 64 });
      }
    } catch {}
  }
});

client.login(process.env.CULT_TOKEN);