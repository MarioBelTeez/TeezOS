import { describe, expect, it } from "vitest";
import { parseQuestionInput } from "./QuestionCard.tsx";

describe("parseQuestionInput", () => {
	it("parses Claude AskUserQuestion format", () => {
		const questions = parseQuestionInput({
			questions: [
				{
					header: "Style",
					question: "Which theme?",
					multiSelect: false,
					options: [
						{ label: "Dark", description: "Easy on OLED" },
						{ label: "Light", description: "Daylight" },
					],
				},
			],
		});
		expect(questions).toHaveLength(1);
		expect(questions[0]).toEqual({
			header: "Style",
			question: "Which theme?",
			multiSelect: false,
			options: [
				{ label: "Dark", description: "Easy on OLED" },
				{ label: "Light", description: "Daylight" },
			],
		});
	});

	it("parses Antigravity ask_question format", () => {
		const questions = parseQuestionInput({
			questions: [
				{
					question: "Pick targets",
					is_multi_select: true,
					options: ["PC", "Phone"],
				},
			],
		});
		expect(questions).toEqual([
			{
				header: undefined,
				question: "Pick targets",
				multiSelect: true,
				options: [{ label: "PC" }, { label: "Phone" }],
			},
		]);
	});
});
