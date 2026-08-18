const axios = require('axios');

async function askDeepSeek(apiKey, prompt) {
  const response = await axios.post(
    'https://api.deepseek.com/v1/chat/completions',
    {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'Tu es un développeur expert. Réponds avec des modifications de code précises.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
    },
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data.choices[0].message.content;
}

module.exports = { askDeepSeek };