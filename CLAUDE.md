# Recorder — One-Tap Meeting & Classroom Intelligence App

## What this is
A mobile app (React Native/Expo) that records meetings and classes with one tap, then produces structured, role-specific summaries using the user's own DeepSeek/Qwen API key. Includes a RAG knowledge base, built-in LLM agent for Q&A, and a skill extraction/consolidation engine.

## Tech Stack
- React Native (Expo) — cross-platform mobile
- expo-av — audio recording
- whisper.cpp — on-device speech-to-text
- DeepSeek/Qwen API — LLM for summarization, embedding, agent
- SQLite + pure-JS vector similarity — local knowledge base
- expo-secure-store — API key storage

## Architecture
Local-first mobile app. Zero server infrastructure. User brings their own API key. All data stored on-device.

See full design doc: ~/.gstack/projects/Recorder/tongli123-unknown-design-20260616-185724.md
