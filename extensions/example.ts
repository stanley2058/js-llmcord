import { z } from "zod/v3";
import { tool } from "ai";

export default async function ExampleWeatherTool() {
  return {
    getWeather: tool({
      description: "Get the weather in a location",
      inputSchema: z.object({
        location: z.string().describe("Location to check"),
      }),
      execute: async ({ location }) => {
        return `The weather in ${location} is sunny.`;
      },
    }),
  };
}
