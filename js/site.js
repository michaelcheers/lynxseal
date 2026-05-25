// Please see documentation at https://docs.microsoft.com/aspnet/core/client-side/bundling-and-minification
// for details on configuring this project to bundle and minify static web assets.

// Write your JavaScript code.

function fileUpload(input) {
    let filesSelectedSpan = input.closest('div').querySelector('div p span');
    filesSelectedSpan.innerText = ` - ${input.files.length} file(s) selected`;
}
function getBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => {
            let dataUrl = reader.result.toString();
            let base64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
            //.replace(/^data:(.*,)?/, '');
            //if ((encoded.length % 4) > 0) {
            //    encoded += '='.repeat(4 - (encoded.length % 4));
            //}
            resolve(base64);
        };
        reader.onerror = error => reject(error);
    });
}
function getUint8Array(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsArrayBuffer(file);
        reader.onload = () => {
            const arrayBuffer = reader.result;
            const uint8Array = new Uint8Array(arrayBuffer);
            resolve(uint8Array);
        };
        reader.onerror = error => reject(error);
    });
}

function getNameWithoutExtension(name) {
    return name.split(/[\\/]/g).pop().split('.')[0];
}
function getExtension(name) {
    return '.' + name.split('.').pop().toLowerCase();
}
function reportFileValidity(fileInput) {
    let validityMessages = [];
    let accept = fileInput.accept.split(',').map(e => e.toLowerCase());
    for (let file of fileInput.files) {
        let extension = getExtension(file.name);
        if (!accept.includes(extension))
        {
            validityMessages.push(`File extension does not match allowed extensions (${accept.join(', ')})`);
        }
    }
    fileInput.setCustomValidity(validityMessages.join(', '));
}
async function downloadUint8Array(contentType, uint8Array, fileName, handle) {
    // Create a blob from the Uint8Array
    const fileBlob = new Blob([uint8Array], { type: contentType });

    if (window.showSaveFilePicker && handle) {
        // Use the File System Access API if available
        const writable = await handle.createWritable();
        await writable.write(fileBlob);
        await writable.close();
    }
    else {
        // Fallback to download link approach
        const url = URL.createObjectURL(fileBlob);
        const downloadLink = document.createElement("a");
        downloadLink.href = url;
        downloadLink.download = fileName;
        downloadLink.click();

        // Clean up the URL object after the download is triggered
        setTimeout(() => {
            URL.revokeObjectURL(url);
        }, 1000);
    }
}
async function downloadBase64File(contentType, base64Data, fileName, handle) {
    if (window.showSaveFilePicker) {
        const fileBlob = b64toBlob(base64Data, contentType);
        const writable = await handle.createWritable();
        await writable.write(fileBlob);
        writable.close();
    }
    else {
        const linkSource = `data:${contentType};base64,${base64Data}`;
        const downloadLink = document.createElement("a");
        downloadLink.href = linkSource;
        downloadLink.download = fileName;
        downloadLink.click();
    }
}
// Rename the original function to better describe what it does
//function urlToBase64(url) {
//    return fetch(url)
//        .then(response => response.blob())
//        .then(blob => blobToBase64(blob));
//}

// Create a proper blobToBase64 function
function blobToBase64URL(blob) {
    return new Promise(callback => {
        let reader = new FileReader();
        reader.onload = function () {
            // This returns the full data URL
            // For just the base64 part, use: this.result.substring(this.result.indexOf(',') + 1)
            callback(this.result)
        };
        reader.readAsDataURL(blob);
    });
}

function uint8ArrayToBase64URL(uint8Array, mime) {
    // The Blob constructor expects an options object with a 'type' property for MIME type
    const blob = new Blob([uint8Array], { type: mime });
    return blobToBase64URL(blob);
}


const b64toBlob = (b64Data, contentType = '', sliceSize = 512) => {
    const byteCharacters = atob(b64Data);
    const byteArrays = [];

    for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
        const slice = byteCharacters.slice(offset, offset + sliceSize);

        const byteNumbers = new Array(slice.length);
        for (let i = 0; i < slice.length; i++) {
            byteNumbers[i] = slice.charCodeAt(i);
        }

        const byteArray = new Uint8Array(byteNumbers);
        byteArrays.push(byteArray);
    }

    const blob = new Blob(byteArrays, { type: contentType });
    return blob;
}
function q(name, defaultValue) {
    return new URLSearchParams(window.location.search).get(name) ?? defaultValue;
}
function modifyURL(newURL) {
    history.replaceState({}, '', newURL);
}
function modifyQS(key, value, defaultValue) {
    if (value !== undefined && value === defaultValue)
        value = undefined;
    modifyURL(withQS(location.href, key, value));
}
function withQS(uri, key, value) {
    var re = new RegExp("([?&])" + key + "=.*?(&|#|$)", "i");
    if (value === undefined) {
        if (uri.match(re)) {
            return uri.replace(re, '$1$2').replace(/[?&]$/, '').replaceAll(/([?&])&+/g, '$1').replace(/[?&]#/, '#');
        }
        else {
            return uri.replace(new RegExp(`[?]${key}&`), '?')
                .replace(new RegExp(`[?]${key}$`), '')
                .replace(new RegExp(`[&]${key}(&|$)`), '$1');
        }
    }
    else {
        if (uri.match(re)) {
            return uri.replace(re, '$1' + key + "=" + value + '$2');
        } else {
            var hash = '';
            if (uri.indexOf('#') !== -1) {
                hash = uri.replace(/.*#/, '#');
                uri = uri.replace(/#.*/, '');
            }
            var separator = uri.indexOf('?') !== -1 ? "&" : "?";
            return uri + separator + key + "=" + value + hash;
        }
    }
}
const sleep = ms => new Promise(r => setTimeout(r, ms ?? 10));

function getErrorOrNull(e) {
    if (e instanceof Error) {
        const userVisibleExceptionStart = 'SuperSigning.UserVisibleException: ';
        if (e?.message?.startsWith(userVisibleExceptionStart)) {
            return e?.message?.split('\n')?.[0].substr?.(userVisibleExceptionStart.length);
        }
    }
    else if (e instanceof String)
        return e;
    return undefined;
}
const getError = e => getErrorOrNull(e) ?? 'An error occurred';
function reportErrorAlert(e) {
    let msgText = getError(e);
    alert(`Error

${msgText}`);
}
function byName(elem) {
    return new Proxy({}, {
        get(_, prop) { return elem.querySelector(`[name=${prop}]`); }
    });
}

const addPadding = input => input + 'A=';
const removePadding = input => input.replace(/A=$/, '');
const toCustomBase64 = custom => removePadding(custom).replaceAll('O', '-').replaceAll('l', '=');
const fromCustomBase64 = b => addPadding(b.replaceAll('O', '0').replaceAll('l', 'I').replaceAll('-', 'O').replaceAll('=', 'l'));