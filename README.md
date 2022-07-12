![Bitloops](https://storage.googleapis.com/wwwbitloopscom/bitloops-logo_320x80.png)

# bitloops-ermis-subscriber

Bitloops Ermis subscriber library for the browser and node.js written in TypeScript

## Usage

### Installing

Using npm:

```bash
$ npm install bitloops-ermis-subscriber
```

Using yarn:

```bash
$ yarn add bitloops-ermis-subscriber
```

### TypeScript Frontend usage Example

```ts
import app from 'bitloops-ermis-subscriber';

// You will get this from your Console in your Workflow information
const bitloopsConfig = {
	apiKey: "kgyst344ktst43kyygk4tkt4s",
	server: "bitloops.net",
	environmentId: "3c42a5ef-fe21-4b50-8128-8596ea47da93",
	workspaceId: "4f7a0fc5-fe2f-450a-b246-11a0873e91f0",
	messagingSenderId: "742387243782",
}

const bitloops = app.initialize(bitloopsConfig);

bitloops.subscribe('my-topic', 'my-event', (data: any) => { console.log('received my-event data', data)});

## Questions?

Please post your questions on [Stack Overflow](https://stackoverflow.com) making sure you use the **Bitloops** tag and someone from the Bitloops team or the community will make sure to help you.

Alternatively feel free to [submit an Issue on GitHub](https://github.com/bitloops/bitloops-ermis-subscriber/issues/new).
