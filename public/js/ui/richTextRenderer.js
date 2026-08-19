import { MyDomElement, parse as parseRichText } from "./textStyleParse.js";

function createStyledSpan(node) {
    const span = document.createElement("span");
    if (node.tagName === "color") {
        if (!String(node.tagValue || "").toLowerCase().startsWith("#ffffff")) {
            span.style.color = node.tagValue;
        }
    } else if (node.tagName === "i") {
        span.style.fontStyle = "italic";
    }

    return span;
}

function appendTextWithHighlight(container, text, lowerKeyword) {
    if (!lowerKeyword || !text) {
        container.appendChild(document.createTextNode(text));
        return;
    }

    const lowerText = text.toLowerCase();
    let position = 0;

    while (position < text.length) {
        const matchIndex = lowerText.indexOf(lowerKeyword, position);
        if (matchIndex === -1) {
            container.appendChild(document.createTextNode(text.substring(position)));
            break;
        }

        if (matchIndex > position) {
            container.appendChild(document.createTextNode(text.substring(position, matchIndex)));
        }

        const mark = document.createElement("mark");
        mark.className = "keyword-highlight";
        mark.textContent = text.substring(matchIndex, matchIndex + lowerKeyword.length);
        container.appendChild(mark);
        position = matchIndex + lowerKeyword.length;
    }
}

function iterateRichNode(node, lineElements, containerStack, labelStack, lowerKeyword) {
    let container = containerStack[containerStack.length - 1];
    if (node.tagName !== "root") {
        labelStack.push(node);
    }

    for (const child of node.children) {
        if (typeof child === "string") {
            const lines = child.split("\n");
            for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
                if (lineIndex > 0) {
                    const newParagraph = document.createElement("p");
                    lineElements.push(newParagraph);
                    containerStack[0] = newParagraph;
                    let stackIndex = 1;

                    for (const label of labelStack) {
                        const span = createStyledSpan(label);
                        (stackIndex === 1 ? newParagraph : containerStack[stackIndex - 1]).appendChild(span);
                        containerStack[stackIndex] = span;
                        container = span;
                        stackIndex += 1;
                    }
                }

                appendTextWithHighlight(container, lines[lineIndex], lowerKeyword);
            }
        } else {
            const span = createStyledSpan(child);
            containerStack.push(span);
            container.appendChild(span);
            iterateRichNode(child, lineElements, containerStack, labelStack, lowerKeyword);
        }
    }

    labelStack.pop();
    containerStack.pop();
}

function buildPlainTextFragment(text, lowerKeyword) {
    const fragment = document.createDocumentFragment();
    const lines = String(text ?? "").split("\n");

    for (const line of lines) {
        const paragraph = document.createElement("p");
        appendTextWithHighlight(paragraph, line, lowerKeyword);
        fragment.appendChild(paragraph);
    }

    return fragment;
}

export function stylizeText(text, keyword) {
    if (!text) {
        return document.createDocumentFragment();
    }

    const lowerKeyword = keyword ? keyword.toLowerCase() : "";

    try {
        const root = new MyDomElement();
        root.children = parseRichText(text);
        root.tagName = "root";

        const fragment = document.createDocumentFragment();
        const firstParagraph = document.createElement("p");
        const lineElements = [firstParagraph];
        const containerStack = [firstParagraph];
        const labelStack = [];

        iterateRichNode(root, lineElements, containerStack, labelStack, lowerKeyword);

        for (const element of lineElements) {
            fragment.appendChild(element);
        }

        return fragment;
    } catch (error) {
        console.warn("Failed to parse rich text.", error);
        return buildPlainTextFragment(text, lowerKeyword);
    }
}
