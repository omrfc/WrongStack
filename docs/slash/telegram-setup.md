# /telegram-setup - Telegram Plugin Setup

Configures the Telegram bridge plugin by validating and saving a bot token and
optional default chat id. The command performs a live `getMe` request against
the Telegram API before writing configuration.

Alias: `/tg-setup`.

## Usage

| Command | Effect |
|---|---|
| `/telegram-setup` | Show setup instructions and plugin install hint |
| `/telegram-setup help` | Show command help |
| `/telegram-setup <botToken>` | Validate and save a bot token |
| `/telegram-setup <botToken> <chatId>` | Validate and save token plus default chat id |

## Setup Flow

1. Create a bot with `@BotFather` and copy its token.
2. Message the bot once.
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id`.
4. Run `/telegram-setup <botToken> <chatId>`.
5. Restart WrongStack so the Telegram plugin can load the new settings.

## Code Reference

- `packages/cli/src/slash-commands/telegram-setup.ts`
- `packages/cli/src/settings-menu.ts`
- `packages/telegram/`
