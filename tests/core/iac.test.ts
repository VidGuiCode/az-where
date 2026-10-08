import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/core/errors.js";
import {
  detectIacFormat,
  parseIacContent,
  type IacFileParseResult,
} from "../../src/core/iac.js";

const parseTf = (content: string): IacFileParseResult =>
  parseIacContent("main.tf", "terraform", content);
const parseBicep = (content: string): IacFileParseResult =>
  parseIacContent("main.bicep", "bicep", content);

/* ── Terraform fixtures ────────────────────────────────────────────────── */

const TF_MIXED = `terraform {
  required_providers {
    azurerm = {
      source = "hashicorp/azurerm"
    }
  }
}

resource "azurerm_resource_group" "rg" {
  location = "westeurope"
  name     = "rg-demo"
}

resource "azurerm_linux_virtual_machine" "vm_linux" {
  name                  = "vm-linux"
  location              = "westeurope"
  size                  = "Standard_B1s"
  admin_username        = "demo"
  network_interface_ids = ["/subscriptions/x/nics"]
  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
  }
  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts-gen2"
    version   = "latest"
  }
}

resource "azurerm_windows_virtual_machine" "vm_win" {
  name      = "vm-win"
  location  = azurerm_resource_group.rg.location
  size      = "Standard_D2s_v5"
  admin_username = "demo"
}

resource "azurerm_virtual_machine" "vm_legacy" {
  name                  = "vm-legacy"
  location              = "francecentral"
  vm_size               = "Standard_B2ms"
  network_interface_ids = ["/subscriptions/x/nics"]
}

resource "azurerm_linux_virtual_machine_scale_set" "vmss" {
  name     = "vmss"
  location = "westeurope"
  sku {
    name     = "Standard_D2s_v5"
    capacity = 3
  }
}

resource "azurerm_orchestrated_virtual_machine_scale_set" "vmss_dyn" {
  name     = "vmss-dyn"
  location = "northeurope"
  sku {
    name     = "Standard_B4ms"
    tier     = "Standard"
  }
  platform_fault_domain_count = 2
}
`;

/* ── Bicep fixtures ────────────────────────────────────────────────────── */

const BICEP_MIXED = `param location string = 'westeurope'

resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: 'vm'
  location: 'westeurope'
  properties: {
    hardwareProfile: {
      vmSize: 'Standard_B1s'
    }
    osProfile: {
      computerName: 'vm'
      adminUsername: 'demo'
    }
  }
}

resource vmRg 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: 'vm-rg'
  location: resourceGroup().location
  properties: {
    hardwareProfile: {
      vmSize: 'Standard_D2s_v5'
    }
  }
}

resource vmss 'Microsoft.Compute/virtualMachineScaleSets@2024-07-01' = {
  name: 'vmss'
  location: 'northeurope'
  sku: {
    name: 'Standard_B2s'
    capacity: 2
  }
  properties: {
    virtualMachineProfile: {
      networkProfile: {
        networkInterfaceConfigurations: [
          {
            name: 'nic'
          }
        ]
      }
    }
  }
}

resource stg 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'stg'
  location: 'westeurope'
  sku: {
    name: 'Standard_LRS'
  }
}
`;

/* ── detectIacFormat ───────────────────────────────────────────────────── */

describe("detectIacFormat", () => {
  it("maps .tf and .bicep extensions (case-insensitive)", () => {
    expect(detectIacFormat("main.tf")).toBe("terraform");
    expect(detectIacFormat("VM/Main.TF")).toBe("terraform");
    expect(detectIacFormat("deploy.bicep")).toBe("bicep");
  });

  it("rejects other extensions with a usage error", () => {
    expect(() => detectIacFormat("main.txt")).toThrow(ValidationError);
    expect(() => detectIacFormat("main.json")).toThrow(/\.tf \(Terraform\) or \.bicep/);
  });

  it("rejects JSON-syntax Terraform explicitly", () => {
    expect(() => detectIacFormat("main.tf.json")).toThrow(/JSON-syntax Terraform/);
  });
});

/* ── Terraform parsing ─────────────────────────────────────────────────── */

describe("parseTerraform", () => {
  it("extracts a literal location+size pair with file, line, and capacity 1", () => {
    const { pairs } = parseTf(TF_MIXED);
    const linux = pairs.find((p) => p.resourceName === "vm_linux");
    expect(linux).toMatchObject({
      file: "main.tf",
      format: "terraform",
      resourceType: "azurerm_linux_virtual_machine",
      resourceName: "vm_linux",
      sku: "Standard_B1s",
      locationLiteral: "westeurope",
      capacity: 1,
    });
    // The resource header sits on line 14 of TF_MIXED.
    expect(linux?.line).toBe(14);
  });

  it("reads vm_size from the legacy azurerm_virtual_machine type", () => {
    const { pairs } = parseTf(TF_MIXED);
    expect(pairs.find((p) => p.resourceName === "vm_legacy")).toMatchObject({
      sku: "Standard_B2ms",
      locationLiteral: "francecentral",
    });
  });

  it("reads sku name and literal capacity from scale-set sku blocks", () => {
    const { pairs } = parseTf(TF_MIXED);
    expect(pairs.find((p) => p.resourceName === "vmss")).toMatchObject({
      sku: "Standard_D2s_v5",
      locationLiteral: "westeurope",
      capacity: 3,
    });
    // A sku block without capacity (orchestrated sets) stays checkable with
    // capacity null — scanning treats it as a single instance.
    expect(pairs.find((p) => p.resourceName === "vmss_dyn")).toMatchObject({
      sku: "Standard_B4ms",
      capacity: null,
    });
  });

  it("skips resources whose location or size is dynamic, echoing the raw expression", () => {
    const { skipped } = parseTf(TF_MIXED);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({
      resourceName: "vm_win",
      reason: "dynamic-location",
      detail: "azurerm_resource_group.rg.location",
      line: 32,
    });
  });

  it("counts every VM/scale-set resource, checkable or skipped", () => {
    const result = parseTf(TF_MIXED);
    expect(result.vmResourceCount).toBe(5);
    expect(result.pairs).toHaveLength(4);
    expect(result.skipped).toHaveLength(1);
  });

  it("ignores non-VM resources and blocks that are not resources", () => {
    const result = parseTf(TF_MIXED);
    const names = [
      ...result.pairs.map((p) => p.resourceName),
      ...result.skipped.map((s) => s.resourceName),
    ];
    expect(names).not.toContain("rg");
  });

  it("skips interpolated strings instead of guessing", () => {
    const { skipped, pairs } = parseTf(`resource "azurerm_linux_virtual_machine" "vm" {
  location = "\${var.region}"
  size     = "Standard_B1s"
}
`);
    expect(pairs).toHaveLength(0);
    expect(skipped[0]).toMatchObject({ reason: "dynamic-location", detail: '"\${var.region}"' });
  });

  it("skips a dynamic size while keeping a literal location pairable", () => {
    const { skipped } = parseTf(`resource "azurerm_linux_virtual_machine" "vm" {
  location = "westeurope"
  size     = var.vm_size
}
`);
    expect(skipped[0]).toMatchObject({ reason: "dynamic-sku", detail: "var.vm_size" });
  });

  it("ignores commented-out resources (#, //, block comments)", () => {
    const content = `# resource "azurerm_linux_virtual_machine" "ghost" {
#   location = "westeurope"
#   size     = "Standard_B1s"
# }
// resource "azurerm_linux_virtual_machine" "ghost2" { location = "westeurope" size = "Standard_B1s" }
/*
resource "azurerm_linux_virtual_machine" "ghost3" {
  location = "westeurope"
  size = "Standard_B1s"
}
*/
resource "azurerm_linux_virtual_machine" "real" {
  location = "westeurope" // trailing comment
  size     = "Standard_B1s" # trailing comment
}
`;
    const result = parseTf(content);
    expect(result.vmResourceCount).toBe(1);
    expect(result.pairs[0]?.resourceName).toBe("real");
  });

  it("ignores heredoc contents even when they look like resources", () => {
    const content = `resource "azurerm_linux_virtual_machine" "vm" {
  location = "westeurope"
  size     = "Standard_B1s"
  custom_data = <<EOT
resource "azurerm_linux_virtual_machine" "fake" {
  location = "eastus"
  size     = "Standard_D2s_v5"
}
EOT
}
`;
    const result = parseTf(content);
    expect(result.vmResourceCount).toBe(1);
    expect(result.pairs[0]).toMatchObject({
      resourceName: "vm",
      locationLiteral: "westeurope",
      sku: "Standard_B1s",
    });
  });

  it("normalizes a short SKU literal to the canonical form", () => {
    const { pairs } = parseTf(`resource "azurerm_linux_virtual_machine" "vm" {
  location = "westeurope"
  size     = "B1s"
}
`);
    expect(pairs[0]?.sku).toBe("Standard_B1s");
  });

  it("handles display-name locations without interpreting them", () => {
    const { pairs } = parseTf(`resource "azurerm_linux_virtual_machine" "vm" {
  location = "West Europe"
  size     = "Standard_B1s"
}
`);
    expect(pairs[0]?.locationLiteral).toBe("West Europe");
  });

  it("reports an empty file as zero resources", () => {
    const result = parseTf("");
    expect(result.vmResourceCount).toBe(0);
    expect(result.pairs).toHaveLength(0);
  });
});

/* ── Bicep parsing ─────────────────────────────────────────────────────── */

describe("parseBicep", () => {
  it("extracts literal pairs including nested hardwareProfile.vmSize", () => {
    const { pairs } = parseBicep(BICEP_MIXED);
    expect(pairs.find((p) => p.resourceName === "vm")).toMatchObject({
      file: "main.bicep",
      format: "bicep",
      resourceType: "Microsoft.Compute/virtualMachines",
      sku: "Standard_B1s",
      locationLiteral: "westeurope",
      capacity: 1,
      line: 3,
    });
  });

  it("skips resourceGroup().location with the expression echoed", () => {
    const { skipped } = parseBicep(BICEP_MIXED);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({
      resourceName: "vmRg",
      reason: "dynamic-location",
      detail: "resourceGroup().location",
    });
  });

  it("reads sku name and capacity from scale sets, ignoring other name properties", () => {
    const { pairs } = parseBicep(BICEP_MIXED);
    const vmss = pairs.find((p) => p.resourceName === "vmss");
    expect(vmss).toMatchObject({
      resourceType: "Microsoft.Compute/virtualMachineScaleSets",
      sku: "Standard_B2s",
      capacity: 2,
      locationLiteral: "northeurope",
    });
  });

  it("counts only VM/scale-set resources (storage sku objects are not pairs)", () => {
    const result = parseBicep(BICEP_MIXED);
    expect(result.vmResourceCount).toBe(3);
    expect(result.pairs).toHaveLength(2);
    expect(result.pairs.map((p) => p.resourceName)).not.toContain("stg");
  });

  it("skips param-driven locations as dynamic", () => {
    const { skipped, pairs } = parseBicep(`param location string

resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: 'vm'
  location: location
  properties: {
    hardwareProfile: {
      vmSize: 'Standard_B1s'
    }
  }
}
`);
    expect(pairs).toHaveLength(0);
    expect(skipped[0]).toMatchObject({ reason: "dynamic-location", detail: "location" });
  });

  it("skips string interpolation in Bicep values", () => {
    const { skipped } = parseBicep(`resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: 'vm'
  location: '\${prefix}eastus'
  properties: {
    hardwareProfile: {
      vmSize: 'Standard_B1s'
    }
  }
}
`);
    expect(skipped[0]).toMatchObject({ reason: "dynamic-location", detail: "'\${prefix}eastus'" });
  });

  it("ignores existing resources and commented-out ones", () => {
    const content = `// resource ghost 'Microsoft.Compute/virtualMachines@2024-07-01' = { location: 'westeurope' }
resource vmExisting 'Microsoft.Compute/virtualMachines@2024-07-01' existing = {
  name: 'vm-existing'
}
resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: 'vm'
  location: 'westeurope'
  properties: {
    hardwareProfile: {
      vmSize: 'Standard_B1s'
    }
  }
}
`;
    const result = parseBicep(content);
    expect(result.vmResourceCount).toBe(1);
    expect(result.pairs[0]?.resourceName).toBe("vm");
  });

  it("parses for-loop scale sets written as [for …] bodies", () => {
    const { pairs } = parseBicep(`resource vmss 'Microsoft.Compute/virtualMachineScaleSets@2024-07-01' = [for i in range(0, 2): {
  name: 'vmss-\${i}'
  location: 'westeurope'
  sku: {
    name: 'Standard_B2s'
    capacity: 2
  }
}]
`);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ sku: "Standard_B2s", capacity: 2 });
  });

  it("ignores multi-line ''' string contents", () => {
    const content = `var script = '''
resource ghost 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  location: 'eastus'
}
'''

resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: 'vm'
  location: 'westeurope'
  properties: {
    hardwareProfile: {
      vmSize: 'Standard_B1s'
    }
  }
}
`;
    const result = parseBicep(content);
    expect(result.vmResourceCount).toBe(1);
    expect(result.pairs[0]?.resourceName).toBe("vm");
  });
});
