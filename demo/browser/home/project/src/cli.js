#!/usr/bin/env node
import { readings } from "./readings.js";

const city = process.argv[2];
if (!city) {
  console.error("Usage: forecast <city>");
  process.exit(1);
}

const reading = readings[city.toLowerCase()];
if (!reading) {
  console.error(`No forecast for ${city}. Try Berlin, Lisbon or Oslo.`);
  process.exit(1);
}

console.log(`${city}: ${reading.sky}, ${reading.low}-${reading.high}°C, ${Math.round(reading.rain * 100)}% chance of rain`);
