# 03 — Multi-Provider

Examples showing provider switching and custom endpoints.

## Switch at launch

```bash
# Anthropic (default)
wrongstack --provider anthropic --model claude-opus-4-7 "explain the agent loop"

# OpenAI
wrongstack --provider openai --model gpt-4.1 "explain the agent loop"

# Groq (fast, cheap)
wrongstack --provider groq --model llama-3.3-70b-versatile "explain the agent loop"

# DeepSeek
wrongstack --provider deepseek --model deepseek-chat "explain the agent loop"

# OpenRouter (access to many models)
wrongstack --provider openrouter --model anthropic/claude-opus-4 "explain the agent loop"
```

## Switch at runtime

Inside REPL or TUI:

```
/model                    # interactive provider → model picker
/use openai gpt-4.1      # direct switch
```

## Custom endpoint (Ollama)

```jsonc
// ~/.wrongstack/config.json
{
  "providers": {
    "ollama": {
      "type": "openai-compatible",
      "baseUrl": "http://localhost:11434/v1",
      "family": "openai-compatible",
      "model": "llama3.3"
    }
  }
}
```

```bash
wrongstack --provider ollama --model llama3.3 "hello"
```

## Custom endpoint (self-hosted)

```jsonc
{
  "providers": {
    "my-llm": {
      "type": "openai-compatible",
      "baseUrl": "https://llm.internal.company.com/v1",
      "apiKey": "enc:v1:...",
      "family": "openai-compatible",
      "model": "custom-model-7b"
    }
  }
}
```

## Backup provider pattern

Configure multiple providers so you can switch when one is rate-limited:

```jsonc
{
  "provider": "anthropic",
  "model": "claude-opus-4-7",
  "providers": {
    "anthropic": { "apiKey": "enc:v1:..." },
    "openai": { "apiKey": "enc:v1:..." },
    "groq": {
      "apiKey": "enc:v1:...",
      "baseUrl": "https://api.groq.com/openai/v1"
    }
  }
}
```

Then switch at runtime with `/model` when needed.
