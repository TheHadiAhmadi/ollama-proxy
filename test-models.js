const axios = require('axios');

const PROXY_URL = 'http://localhost:6754';

const testMessages = [
  {
    name: 'Simple question',
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: 'What is 2 + 2?' }]
    }]
  },
  {
    name: 'Tool use request',
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: 'Get the current weather in New York' }]
    }],
    tools: [{
      name: 'get_weather',
      description: 'Get current weather for a location',
      input_schema: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'City name' }
        },
        required: ['location']
      }
    }]
  }
];

async function testModel(model, testName) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing: ${model} - ${testName}`);
  console.log('='.repeat(60));

  for (const test of testMessages) {
    console.log(`\n  Test: ${test.name}`);
    try {
      const response = await axios.post(`${PROXY_URL}/v1/messages?beta=true`, {
        model,
        messages: test.messages,
        tools: test.tools,
        max_tokens: 1024,
        stream: false
      }, {
        timeout: 30000
      });

      console.log(`    Status: ${response.status}`);
      if (response.data.content) {
        const firstBlock = response.data.content[0];
        if (firstBlock.type === 'text') {
          console.log(`    Response: ${firstBlock.text?.substring(0, 100)}...`);
        } else {
          console.log(`    Response type: ${firstBlock.type}`);
        }
      }

      const toolUse = response.data.content?.find(b => b.type === 'tool_use');
      if (toolUse) {
        console.log(`    Tool use detected: ${toolUse.name}`);
        console.log(`    Has thought_signature: ${!!toolUse.thought_signature}`);
      }

    } catch (error) {
      console.log(`    ERROR: ${error.response?.data?.error?.message || error.message}`);
    }
  }
}

async function main() {
  console.log('Starting model comparison tests...\n');

  await testModel('gemini-3-flash-preview:cloud', 'Gemini');
  await testModel('qwen3.5:cloud', 'Qwen');

  console.log('\n' + '='.repeat(60));
  console.log('Tests completed!');
  console.log('='.repeat(60));
}

main().catch(console.error);