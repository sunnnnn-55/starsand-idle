// WebSocket 協定（JSON 文字訊息）v2
export const PROTOCOL_VERSION = 2;
export const C2S_TYPES = ['auth', 'move', 'attack', 'useSkill', 'usePotion', 'useItem', 'equip', 'unequip', 'autoHunt', 'pickup', 'sortInv', 'discard',
    'learnSkill', 'talk', 'shopBuy', 'shopSell', 'enhance', 'teleport', 'questAccept', 'questTurnIn', 'questAbandon', 'chat',
    'partyInvite', 'partyRespond', 'partyLeave', 'partyKick', 'tradeRequest', 'tradeRespond', 'tradeOffer', 'tradeLock', 'tradeConfirm', 'tradeCancel',
    'dailyClaim', 'settings', 'respawn', 'recall', 'ping',
    'pk', 'advance', 'craft', 'whList', 'whPut', 'whTake', 'guildCreate', 'guildInvite', 'guildRespond', 'guildLeave', 'guildKick', 'guildInfo', 'dailyQuestClaim', 'gm'];
export const WS_CLOSE = { OTHER_LOGIN: 4001, AUTH_FAILED: 4003, REQUIRED_UPDATE: 4009, PROTOCOL: 4400 };
export const CHAT_CHANNELS = ['world', 'near', 'party', 'guild'];
