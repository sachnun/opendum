import { plugin } from "bun";
import { readFileSync } from "node:fs";
import { compileScript, compileTemplate, parse } from "vue/compiler-sfc";

plugin({
  name: "vue-sfc",
  setup(build) {
    build.onLoad({ filter: /\.vue$/ }, (args) => {
      const source = readFileSync(args.path, "utf8");
      const { descriptor } = parse(source, { filename: args.path });
      const id = args.path;
      const script = compileScript(descriptor, { id, inlineTemplate: false });
      let code = script.content.replace("export default", "const __sfc__ =");

      if (descriptor.template) {
        const template = compileTemplate({
          source: descriptor.template.content,
          filename: args.path,
          id,
          compilerOptions: { bindingMetadata: script.bindings },
        });
        code += `\n${template.code.replace("export function render", "function render")}\n__sfc__.render = render;`;
      }

      code += "\nexport default __sfc__;";
      return { contents: code, loader: "ts" };
    });
  },
});
