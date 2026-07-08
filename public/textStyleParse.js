export class MyDomElement {
    constructor() {
        this.tagName = null;
        this.tagValue = {};
        this.children = [];
    }
}

function closedTagParser(text, startIndex) {
    const ans = new MyDomElement();
    const endIndex = text.length;
    let lastIndex = startIndex;
    let tagName = "";
    let tagValue = "";
    let tagEnded = false;
    let isSelfClosing = false;

    if (text[startIndex] === "<") {
        let tagNameEnded = false;
        for (let index = startIndex + 1; index < endIndex; index += 1) {
            if (text[index] === ">") {
                lastIndex = index + 1;
                tagEnded = true;

                if (text[index - 1] === "/") {
                    isSelfClosing = true;
                    if (tagNameEnded) {
                        tagValue = tagValue.slice(0, -1);
                    } else {
                        tagName = tagName.slice(0, -1);
                    }
                }
                break;
            }

            if (!tagNameEnded && text[index] === "=") {
                tagNameEnded = true;
            } else if (!tagNameEnded) {
                tagName += text[index];
            } else {
                tagValue += text[index];
            }
        }
    } else {
        tagEnded = true;
    }

    if (!tagEnded) {
        throw new Error(`Tag Not Ended at position ${startIndex}`);
    }

    ans.tagName = tagName;
    ans.tagValue = tagValue;

    if (isSelfClosing) {
        return [ans, lastIndex - 1];
    }

    for (let index = lastIndex; index < endIndex; index += 1) {
        if (text[index] !== "<" || index === endIndex - 1) {
            continue;
        }

        if (text[index + 1] !== "/") {
            ans.children.push(text.substring(lastIndex, index));
            const [child, childEndIndex] = closedTagParser(text, index);
            ans.children.push(child);
            index = childEndIndex;
            lastIndex = childEndIndex + 1;
            continue;
        }

        if (tagName === "") {
            throw new Error("String tag should NOT have tail tag!");
        }

        let closeTagNameEnd = index + 2;
        while (closeTagNameEnd < endIndex && text[closeTagNameEnd] !== ">") {
            closeTagNameEnd += 1;
        }

        const closeTagName = text.substring(index + 2, closeTagNameEnd);
        if (closeTagName !== tagName) {
            if (index + tagName.length + 2 > endIndex || text.substring(index + 2, index + 3 + tagName.length) !== `${tagName}>`) {
                throw new Error(`Tag head and Tail Not Match at ${index}. Expected </${tagName}>`);
            }
        }

        ans.children.push(text.substring(lastIndex, index));
        return [ans, index + 2 + tagName.length];
    }

    if (tagName === "") {
        ans.children.push(text.substring(lastIndex, text.length));
        return [ans, endIndex - 1];
    }

    throw new Error(`Tag <${tagName}> Not Closed!`);
}

export function parse(text) {
    if (!text || text.length === 0) {
        return [];
    }

    let lastIndex = -1;
    const ans = [];
    const length = text.length;

    while (lastIndex !== length - 1) {
        const [child, newIndex] = closedTagParser(text, lastIndex + 1);
        ans.push(child);
        lastIndex = newIndex;
    }

    return ans;
}
